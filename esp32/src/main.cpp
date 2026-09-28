// ESP32 Wi-Fi microphone
//
//   INMP441 ──I2S──▶ capture task ──stream buffer──▶ loop() ──WebSocket binary──▶ server
//
// The capture task (core 1) reads the mic continuously and pushes 16-bit PCM
// into a statically allocated FreeRTOS stream buffer. loop() owns Wi-Fi and the
// WebSocket, drains the buffer in AUDIO_FRAME_SAMPLES chunks and sends each as
// one binary frame. No heap allocation happens in the audio path.
//
// Protocol (see ../README.md): hello → welcome → start → [PCM]… → stop

#include <Arduino.h>
#include <ArduinoJson.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <esp_system.h>
#include <esp_task_wdt.h>
#include <freertos/stream_buffer.h>

#include "adpcm.h"
#include "config.h"
#include "mic_i2s.h"

#if DEBUG_SERIAL
#define LOG(fmt, ...) Serial.printf("[%8lu] " fmt "\n", (unsigned long)millis(), ##__VA_ARGS__)
#else
#define LOG(...) \
  do {           \
  } while (0)
#endif

#if SERVER_USE_TLS && !defined(SERVER_ROOT_CA)
#error "SERVER_USE_TLS=1 requires SERVER_ROOT_CA (PEM of the CA that signed the server certificate)"
#endif

// ------------------------------------------------------------------ buffers

// One frame = AUDIO_FRAME_SAMPLES samples = one WebSocket binary message.
static constexpr size_t PCM_FRAME_BYTES = AUDIO_FRAME_SAMPLES * sizeof(int16_t);
#if AUDIO_CODEC_ADPCM
static constexpr size_t FRAME_BYTES = 4 + AUDIO_FRAME_SAMPLES / 2;  // == adpcmBlockBytes()
static constexpr const char *WIRE_FORMAT = "ima_adpcm";
#else
static constexpr size_t FRAME_BYTES = PCM_FRAME_BYTES;
static constexpr const char *WIRE_FORMAT = "pcm_s16le";
#endif
// Bytes per second on the wire (and in the ring buffer).
static constexpr size_t BYTES_PER_SEC = FRAME_BYTES * AUDIO_SAMPLE_RATE / AUDIO_FRAME_SAMPLES;
static constexpr size_t RING_BYTES_RAW = BYTES_PER_SEC * AUDIO_BUFFER_MS / 1000;
// Whole number of frames, and at least four of them.
static constexpr size_t RING_BYTES =
    (RING_BYTES_RAW / FRAME_BYTES < 4 ? 4 : RING_BYTES_RAW / FRAME_BYTES) * FRAME_BYTES;
static constexpr size_t CAPTURE_CHUNK = 256;  // samples per I2S read (16 ms)

static_assert(AUDIO_FRAME_SAMPLES >= CAPTURE_CHUNK, "frame must hold at least one capture chunk");
static_assert(AUDIO_FRAME_SAMPLES % 2 == 0, "frame must hold an even number of samples");
static_assert(FRAME_BYTES <= 15 * 1024, "frame exceeds the WebSockets library's max payload");

// Allocated once in setup() from the heap: a multi-second buffer is too big for
// the static DRAM segment. Never freed, so it cannot fragment the heap.
static StreamBufferHandle_t g_ring = nullptr;
static size_t g_ringBytes = 0;
// Frame buffer with headroom for the WebSocket header: sendBIN(..., headerToPayload=true)
// then writes header + payload in one TCP write and never mallocs, whatever the frame size.
static uint8_t g_txBuf[WEBSOCKETS_MAX_HEADER_SIZE + FRAME_BYTES];
static uint8_t *const g_txFrame = g_txBuf + WEBSOCKETS_MAX_HEADER_SIZE;

// --------------------------------------------------------- shared state

// Written by loop(), read by the capture task.
static volatile bool g_capture = false;
// Written by the capture task, read by loop(). 32-bit loads/stores are atomic on ESP32.
static volatile uint32_t g_droppedBytes = 0;
static volatile uint32_t g_i2sErrors = 0;
static volatile uint32_t g_i2sRestarts = 0;
static volatile uint32_t g_captureBeat = 0;
static volatile bool g_micFailed = false;

static uint32_t g_framesSent = 0;
static uint32_t g_sendFailures = 0;
static uint32_t g_sendStalls = 0;

// -------------------------------------------------------------- link state

enum class Link : uint8_t { WifiDown, WsConnecting, AwaitWelcome, Streaming };
static Link g_link = Link::WifiDown;

static WebSocketsClient g_ws;
static bool g_wsBegun = false;
static uint32_t g_wsDownSince = 0;
static uint32_t g_wsInterval = 0;
static uint32_t g_helloSentAt = 0;
static uint32_t g_lastOnline = 0;  // last time we had a working server link
static bool g_userPaused = false;

static bool g_wifiUp = false;
static bool g_wifiConnecting = false;
static uint32_t g_wifiAttemptStart = 0;
static uint32_t g_wifiNextAttempt = 0;
static uint8_t g_wifiFails = 0;

// Reconnect schedule shared by Wi-Fi and WebSocket: 1 s, 2 s, 5 s, 10 s, then 30 s.
static const uint32_t BACKOFF_MS[] = {1000, 2000, 5000, 10000, 30000};
static uint32_t backoffMs(uint8_t attempt) {
  const uint8_t last = sizeof(BACKOFF_MS) / sizeof(BACKOFF_MS[0]) - 1;
  return BACKOFF_MS[attempt > last ? last : attempt];
}

static const char *resetReasonName() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "power_on";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT: return "interrupt_wdt";
    case ESP_RST_TASK_WDT: return "task_wdt";
    case ESP_RST_WDT: return "other_wdt";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_DEEPSLEEP: return "deep_sleep";
    case ESP_RST_EXT: return "external";
    default: return "unknown";
  }
}

// -------------------------------------------------------------- capture task

static void captureTask(void *) {
  esp_task_wdt_add(nullptr);
  static int16_t pcm[CAPTURE_CHUNK];
  static int16_t frame[AUDIO_FRAME_SAMPLES];  // one frame being assembled
#if AUDIO_CODEC_ADPCM
  static uint8_t encoded[FRAME_BYTES];
  uint8_t adpcmIndex = 0;
#endif
  size_t fill = 0;
  uint32_t errorRun = 0;

  for (;;) {
    esp_task_wdt_reset();
    g_captureBeat = millis();

    // With the I2S clock running, a chunk is ready every 16 ms. A 200 ms
    // timeout therefore means the driver is wedged, same as an error.
    int n = micRead(pcm, CAPTURE_CHUNK, 200);
    if (n <= 0) {
      g_i2sErrors = g_i2sErrors + 1;
      if (++errorRun >= 10) {
        micEnd();
        vTaskDelay(pdMS_TO_TICKS(50));
        if (micBegin()) {
          g_i2sRestarts = g_i2sRestarts + 1;
          errorRun = 0;
        } else if (errorRun >= 60) {
          g_micFailed = true;  // loop() reboots
        }
      }
      continue;
    }
    errorRun = 0;

    if (!g_capture) {  // keep the mic running (and warm) while not streaming
      fill = 0;
      continue;
    }

    // Assemble whole frames; each goes into the ring buffer as one unit (encoded if
    // ADPCM), so the sender always reads complete frames and drops never split one.
    for (int i = 0; i < n; i++) {
      frame[fill++] = pcm[i];
      if (fill < AUDIO_FRAME_SAMPLES) continue;
      fill = 0;
#if AUDIO_CODEC_ADPCM
      adpcmEncodeBlock(frame, AUDIO_FRAME_SAMPLES, encoded, &adpcmIndex);
      const void *out = encoded;
#else
      const void *out = frame;
#endif
      if (xStreamBufferSpacesAvailable(g_ring) >= FRAME_BYTES) {
        xStreamBufferSend(g_ring, out, FRAME_BYTES, 0);
      } else {
        g_droppedBytes = g_droppedBytes + PCM_FRAME_BYTES;  // reported as PCM-equivalent bytes
      }
    }
  }
}

// ------------------------------------------------------------ WebSocket

static void wsSendText(const char *json) {
  if (g_ws.isConnected()) g_ws.sendTXT(json);
}

static void sendHello() {
  static char buf[384];
  snprintf(buf, sizeof(buf),
           "{\"type\":\"hello\",\"device_id\":\"%s\",\"sample_rate\":%d,\"bits\":16,\"channels\":1,"
           "\"format\":\"%s\",\"frame_samples\":%d,\"firmware\":\"%s\",\"ip\":\"%s\",\"mac\":\"%s\","
           "\"rssi\":%d,\"reset_reason\":\"%s\"}",
           DEVICE_ID, AUDIO_SAMPLE_RATE, WIRE_FORMAT, AUDIO_FRAME_SAMPLES, FIRMWARE_VERSION, WiFi.localIP().toString().c_str(),
           WiFi.macAddress().c_str(), WiFi.RSSI(), resetReasonName());
  wsSendText(buf);
}

static void sendTelemetry() {
  static char buf[320];
  snprintf(buf, sizeof(buf),
           "{\"type\":\"telemetry\",\"rssi\":%d,\"free_heap\":%u,\"min_free_heap\":%u,\"uptime_s\":%lu,"
           "\"dropped_bytes\":%lu,\"i2s_errors\":%lu,\"frames_sent\":%lu,\"send_stalls\":%lu,\"mic_gain_db\":%.1f,"
           "\"agc\":%s}",
           WiFi.RSSI(), (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap(), (unsigned long)(millis() / 1000),
           (unsigned long)g_droppedBytes, (unsigned long)g_i2sErrors, (unsigned long)g_framesSent,
           (unsigned long)g_sendStalls, 20.0f * log10f(micGain()), MIC_AGC ? "true" : "false");
  wsSendText(buf);
}

// Discard buffered audio so a new session starts with live sound, not stale audio.
static void drainRing() {
  while (xStreamBufferReceive(g_ring, g_txFrame, FRAME_BYTES, 0) > 0) {
  }
}

// discardBacklog: true only when resuming from a manual pause. After a network
// drop the backlog is kept and sent first, so short outages leave no gap.
static void startStreaming(bool discardBacklog) {
  if (discardBacklog) {
    g_capture = false;
    drainRing();
  }
  size_t backlog = xStreamBufferBytesAvailable(g_ring);
  wsSendText("{\"type\":\"start\"}");
  g_capture = true;
  if (backlog) LOG("Streaming audio (sending %u ms of buffered audio first)", (unsigned)(backlog * 1000 / BYTES_PER_SEC));
  else LOG("Streaming audio");
}

static void stopStreaming(bool tellServer) {
  g_capture = false;
  if (tellServer) wsSendText("{\"type\":\"stop\"}");
}

// Keeps capturing: audio recorded while the link is down waits in the ring buffer
// (up to AUDIO_BUFFER_MS) and is sent after the reconnect.
static void markServerDown() {
  if (g_link == Link::AwaitWelcome || g_link == Link::Streaming) g_wsDownSince = millis();
  g_link = g_wifiUp ? Link::WsConnecting : Link::WifiDown;
}

static void handleServerText(const uint8_t *payload, size_t len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) {
    LOG("Ignoring non-JSON text frame from server");
    return;
  }
  const char *type = doc["type"] | "";
  if (strcmp(type, "welcome") == 0) {
    LOG("Server accepted hello (protocol %d)", doc["protocol"] | 0);
    g_link = Link::Streaming;
    g_lastOnline = millis();
    if (!g_userPaused) startStreaming(false);
    sendTelemetry();
  } else if (strcmp(type, "error") == 0) {
    LOG("Server error: %s", doc["message"] | "?");
  }
}

static void onWsEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      LOG("WebSocket connected to %s:%d%s", SERVER_HOST, SERVER_PORT, SERVER_PATH);
      g_link = Link::AwaitWelcome;
      g_helloSentAt = millis();
      sendHello();
      break;
    case WStype_DISCONNECTED:
      if (g_link == Link::AwaitWelcome || g_link == Link::Streaming) LOG("WebSocket disconnected");
      markServerDown();
      break;
    case WStype_TEXT:
      handleServerText(payload, length);
      break;
    case WStype_ERROR:
      LOG("WebSocket error");
      break;
    default:
      break;  // pings/pongs are answered by the library
  }
}

static void wsBeginOnce() {
  if (g_wsBegun) return;
  g_wsBegun = true;
  static char authHeader[160];
  snprintf(authHeader, sizeof(authHeader), "Authorization: Bearer %s", DEVICE_TOKEN);
  g_ws.setExtraHeaders(authHeader);  // replaces the library's default "Origin: file://"
  g_ws.onEvent(onWsEvent);
  g_ws.setReconnectInterval(BACKOFF_MS[0]);
  // Client-side liveness: ping every 15 s, drop the link after 2 missed pongs.
  g_ws.enableHeartbeat(15000, 5000, 2);
#if SERVER_USE_TLS
  g_ws.beginSslWithCA(SERVER_HOST, SERVER_PORT, SERVER_PATH, SERVER_ROOT_CA, "");
#else
  g_ws.begin(SERVER_HOST, SERVER_PORT, SERVER_PATH, "");
#endif
}

// Stretch the library's retry interval the longer the server stays unreachable.
static void wsUpdateBackoff(uint32_t now) {
  int32_t sinceDown = (int32_t)(now - g_wsDownSince);
  uint32_t down = sinceDown > 0 ? (uint32_t)sinceDown : 0;
  uint32_t interval = down < 5000 ? backoffMs(0)
                      : down < 15000 ? backoffMs(1)
                      : down < 60000 ? backoffMs(2)
                      : down < 180000 ? backoffMs(3)
                                      : backoffMs(4);
  if (interval != g_wsInterval) {
    g_wsInterval = interval;
    g_ws.setReconnectInterval(interval);
    LOG("Server unreachable for %lus, retrying every %lus", (unsigned long)(down / 1000), (unsigned long)(interval / 1000));
  }
}

// -------------------------------------------------------------------- Wi-Fi

static void onWifiUp() {
  LOG("Wi-Fi connected: IP %s, RSSI %d dBm", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  g_wsDownSince = millis();
  g_wsInterval = 0;
  g_link = Link::WsConnecting;
  wsBeginOnce();  // afterwards the library reconnects by itself as long as loop() runs
}

static void onWifiDown() {
  LOG("Wi-Fi lost");
  if (g_ws.isConnected()) g_ws.disconnect();
  g_link = Link::WifiDown;  // capture keeps filling the buffer until Wi-Fi returns
}

// Diagnostics: the driver's reason for every failed association / drop.
static volatile uint8_t g_lastDisconnectReason = 0;

static void onWifiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
    uint8_t reason = info.wifi_sta_disconnected.reason;
    if (reason != g_lastDisconnectReason) {
      LOG("Wi-Fi disconnect reason %u (%s)", reason, WiFi.disconnectReasonName((wifi_err_reason_t)reason));
    }
    g_lastDisconnectReason = reason;
  }
}

static const char *authName(wifi_auth_mode_t m) {
  switch (m) {
    case WIFI_AUTH_OPEN: return "open";
    case WIFI_AUTH_WEP: return "WEP";
    case WIFI_AUTH_WPA_PSK: return "WPA";
    case WIFI_AUTH_WPA2_PSK: return "WPA2";
    case WIFI_AUTH_WPA_WPA2_PSK: return "WPA/WPA2";
    case WIFI_AUTH_WPA2_ENTERPRISE: return "WPA2-Enterprise";
    case WIFI_AUTH_WPA3_PSK: return "WPA3";
    case WIFI_AUTH_WPA2_WPA3_PSK: return "WPA2/WPA3";
    default: return "other";
  }
}

// After a failed attempt, show which networks the board can actually see.
static void logWifiScan() {
#if DEBUG_SERIAL
  esp_task_wdt_reset();
  int n = WiFi.scanNetworks(false, true);  // blocking, include hidden networks, ~2-3 s
  esp_task_wdt_reset();
  if (n < 0) {
    LOG("Wi-Fi scan failed (%d)", n);
    return;
  }
  bool found = false;
  LOG("Wi-Fi scan: %d network(s) visible", n);
  for (int i = 0; i < n && i < 20; i++) {
    bool match = WiFi.SSID(i) == WIFI_SSID;
    found |= match;
    LOG("  %s\"%s\" ch%d %d dBm %s %s", match ? "-> " : "   ", WiFi.SSID(i).c_str(), (int)WiFi.channel(i),
        (int)WiFi.RSSI(i), authName(WiFi.encryptionType(i)), WiFi.BSSIDstr(i).c_str());
  }
  if (!found) LOG("  \"%s\" not seen: out of range, 5 GHz-only, or hidden", WIFI_SSID);
  WiFi.scanDelete();
#endif
}

static void wifiTick(uint32_t now) {
  if (WiFi.status() == WL_CONNECTED) {
    if (!g_wifiUp) {
      g_wifiUp = true;
      g_wifiConnecting = false;
      g_wifiFails = 0;
      onWifiUp();
    }
    return;
  }

  if (g_wifiUp) {
    g_wifiUp = false;
    g_wifiConnecting = false;
    onWifiDown();
    g_wifiNextAttempt = now + backoffMs(0);
  }

  if (g_wifiConnecting) {
    if (now - g_wifiAttemptStart > WIFI_CONNECT_TIMEOUT_MS) {
      uint32_t wait = backoffMs(g_wifiFails++);
      LOG("Wi-Fi connect timed out (status %d); retry in %lus", (int)WiFi.status(), (unsigned long)(wait / 1000));
      WiFi.disconnect();
      if (g_wifiFails == 1 || g_wifiFails % 10 == 0) logWifiScan();
      g_wifiConnecting = false;
      g_wifiNextAttempt = millis() + wait;
    }
    return;
  }

  if ((int32_t)(now - g_wifiNextAttempt) >= 0) {
    LOG("Wi-Fi connecting to \"%s\"", WIFI_SSID);
    WiFi.disconnect();
    // An empty WIFI_PASSWORD means an open network; allow joining it.
    if (WIFI_PASSWORD[0] == '\0') WiFi.setMinSecurity(WIFI_AUTH_OPEN);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    WiFi.setTxPower(WIFI_TX_POWER);  // must follow begin(): the driver resets it on start
    g_wifiConnecting = true;
    g_wifiAttemptStart = now;
  }
}

// -------------------------------------------------------------- health

[[noreturn]] static void gracefulReboot(const char *reason) {
  LOG("Rebooting: %s", reason);
  if (g_ws.isConnected()) {
    stopStreaming(true);
    g_ws.disconnect();
  }
  delay(200);
  ESP.restart();
  for (;;) {
  }
}

static void healthTick(uint32_t now) {
  static uint32_t lowHeapSince = 0;
  if (ESP.getFreeHeap() < MIN_FREE_HEAP_BYTES) {
    if (!lowHeapSince) lowHeapSince = now;
    if (now - lowHeapSince > 10000) gracefulReboot("free heap below MIN_FREE_HEAP_BYTES");
  } else {
    lowHeapSince = 0;
  }

  if (g_micFailed) gracefulReboot("I2S microphone could not be restarted");
  // Signed: the capture task may have stamped a beat after `now` was sampled.
  if ((int32_t)(now - g_captureBeat) > 5000) gracefulReboot("capture task stalled");

  if (g_link == Link::Streaming) g_lastOnline = now;
  if (OFFLINE_REBOOT_MS > 0 && now - g_lastOnline > OFFLINE_REBOOT_MS) gracefulReboot("no server connection for too long");
}

static void buttonTick(uint32_t now) {
#if STREAM_BUTTON_PIN >= 0
  static bool lastLevel = HIGH;
  static uint32_t lastChange = 0;
  bool level = digitalRead(STREAM_BUTTON_PIN);
  if (level == lastLevel || now - lastChange < 50) return;
  lastLevel = level;
  lastChange = now;
  if (level != LOW) return;  // act on press only

  g_userPaused = !g_userPaused;
  if (g_userPaused) {
    LOG("Button: streaming paused");
    stopStreaming(true);
  } else {
    LOG("Button: streaming resumed");
    if (g_link == Link::Streaming) startStreaming(true);
  }
#else
  (void)now;
#endif
}

// Status LED: steady when Wi-Fi is up, otherwise 3 flashes then a 5 s pause.
static void ledTick(uint32_t now) {
#if STATUS_LED_PIN >= 0
  static constexpr uint32_t FLASH_MS = 150;                 // on and off time of one flash
  static constexpr uint32_t PAUSE_MS = 5000;
  static constexpr uint32_t CYCLE_MS = 3 * 2 * FLASH_MS + PAUSE_MS;
  static bool lastOn = false;
  static bool first = true;

  bool on;
  if (g_wifiUp) {
    on = true;
  } else {
    uint32_t t = now % CYCLE_MS;
    on = t < 3 * 2 * FLASH_MS && (t / FLASH_MS) % 2 == 0;  // on, off, on, off, on, off, pause
  }
  if (on != lastOn || first) {
    digitalWrite(STATUS_LED_PIN, (on == (bool)STATUS_LED_ACTIVE_HIGH) ? HIGH : LOW);
    lastOn = on;
    first = false;
  }
#else
  (void)now;
#endif
}

// -------------------------------------------------------------- setup/loop

void setup() {
#if DEBUG_SERIAL
  Serial.begin(115200);
  delay(50);
#endif
  LOG("ESP32 mic %s (%s) booting, reset reason: %s", DEVICE_ID, FIRMWARE_VERSION, resetReasonName());

  // Task watchdog covers loop() and the capture task. The IDF may already have
  // initialised it with a shorter default timeout; reconfigure in that case.
  esp_task_wdt_config_t wdt = {};
  wdt.timeout_ms = WDT_TIMEOUT_S * 1000;
  wdt.idle_core_mask = 0;
  wdt.trigger_panic = true;
  if (esp_task_wdt_reconfigure(&wdt) != ESP_OK) esp_task_wdt_init(&wdt);
  esp_task_wdt_add(nullptr);

  // Largest buffer that fits, stepping down from AUDIO_BUFFER_MS if memory is tight.
  for (size_t want = RING_BYTES; !g_ring && want >= 4 * FRAME_BYTES; want -= 4 * FRAME_BYTES) {
    if (ESP.getMaxAllocHeap() < want + 8 * 1024) continue;  // keep headroom for Wi-Fi
    g_ring = xStreamBufferCreate(want, FRAME_BYTES);
    if (g_ring) g_ringBytes = want;
  }
  if (!g_ring) gracefulReboot("cannot allocate audio buffer");

#if STREAM_BUTTON_PIN >= 0
  pinMode(STREAM_BUTTON_PIN, INPUT_PULLUP);
#endif
#if STATUS_LED_PIN >= 0
  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, STATUS_LED_ACTIVE_HIGH ? LOW : HIGH);
#endif

  for (int attempt = 1; !micBegin(); attempt++) {
    LOG("I2S init failed (attempt %d) — check wiring/pins", attempt);
    if (attempt >= 5) gracefulReboot("I2S init failed");
    delay(500);
    esp_task_wdt_reset();
  }
  LOG("I2S ready: BCLK=%d WS=%d SD=%d, %d Hz, %s slot, %s %u B/s, buffer %u ms (%u bytes), gain %s", I2S_BCLK,
      I2S_LRCLK, I2S_DIN, AUDIO_SAMPLE_RATE, MIC_USE_RIGHT_SLOT ? "right" : "left", WIRE_FORMAT, (unsigned)BYTES_PER_SEC,
      (unsigned)(g_ringBytes * 1000 / BYTES_PER_SEC), (unsigned)g_ringBytes, MIC_AGC ? "AGC" : "fixed");

  g_captureBeat = millis();
  xTaskCreatePinnedToCore(captureTask, "mic", 4096, nullptr, 5, nullptr, 1);

  WiFi.persistent(false);  // don't wear flash rewriting credentials
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(DEVICE_ID);
  WiFi.setSleep(false);  // modem sleep adds 100+ ms latency spikes to a continuous stream
  WiFi.setAutoReconnect(false);  // wifiTick() owns reconnection and its backoff
  WiFi.onEvent(onWifiEvent);

  g_lastOnline = millis();
  g_wifiNextAttempt = millis();
}

void loop() {
  esp_task_wdt_reset();
  const uint32_t now = millis();

  wifiTick(now);
  buttonTick(now);
  ledTick(now);

  if (g_wifiUp) {
    g_ws.loop();  // may block up to ~5 s while (re)connecting; the watchdog allows for it

    // Re-read the clock: callbacks inside g_ws.loop() stamp times later than `now`,
    // and `now - later` would wrap to ~4.29e9 and fire every timeout instantly.
    const uint32_t afterWs = millis();

    if (g_link == Link::WsConnecting) wsUpdateBackoff(afterWs);

    if (g_link == Link::AwaitWelcome && (int32_t)(afterWs - g_helloSentAt) > (int32_t)WS_HANDSHAKE_TIMEOUT_MS) {
      LOG("No welcome from server within %d ms, reconnecting", WS_HANDSHAKE_TIMEOUT_MS);
      g_ws.disconnect();
      markServerDown();
    }

    if (g_link == Link::Streaming && g_capture) {
      // Send what's ready, but yield back to the loop after a few frames. A TCP
      // write can block for seconds when the link stalls, so: feed the watchdog
      // after every frame, stop the burst after any slow send, and treat a very
      // slow send as a dead link and reconnect instead of freezing the loop.
      for (int i = 0; i < 8 && xStreamBufferBytesAvailable(g_ring) >= FRAME_BYTES; i++) {
        size_t got = xStreamBufferReceive(g_ring, g_txFrame, FRAME_BYTES, 0);
        if (got != FRAME_BYTES) break;
        uint32_t t0 = millis();
        bool ok = g_ws.sendBIN(g_txBuf, got, true);
        uint32_t took = millis() - t0;
        esp_task_wdt_reset();
        if (!ok) {
          g_sendFailures++;
          break;  // the library tears the connection down; DISCONNECTED follows
        }
        g_framesSent++;
        if (took > WS_SEND_STALL_MS) {
          g_sendStalls++;
          LOG("Send stalled for %lu ms, reconnecting", (unsigned long)took);
          g_ws.disconnect();
          markServerDown();
          break;
        }
        if (took > 200) break;  // link is slow: let the loop breathe, try again next pass
      }
    }

    static uint32_t lastTelemetry = 0;
    if (g_link == Link::Streaming && now - lastTelemetry >= TELEMETRY_INTERVAL_MS) {
      lastTelemetry = now;
      sendTelemetry();
    }
  }

  healthTick(now);

#if DEBUG_SERIAL
  static uint32_t lastStats = 0;
  if (now - lastStats >= 10000) {
    lastStats = now;
    LOG("stats: link=%d frames=%lu dropped=%luB i2s_err=%lu i2s_restarts=%lu send_fail=%lu heap=%u gain=%.1fdB",
        (int)g_link, (unsigned long)g_framesSent, (unsigned long)g_droppedBytes, (unsigned long)g_i2sErrors,
        (unsigned long)g_i2sRestarts, (unsigned long)g_sendFailures, (unsigned)ESP.getFreeHeap(),
        20.0f * log10f(micGain()));
  }
#endif

  delay(1);  // let the idle task run
}
