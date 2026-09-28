# ESP32 Wi-Fi microphone firmware

Turns an ESP32 + INMP441 I2S microphone into a network audio endpoint. It
captures 16 kHz / 16-bit / mono PCM and streams it as binary WebSocket frames
to the Node.js server in [`../server`](../server). No audio processing beyond
DC removal and gain happens on the device.

## Wiring

```
      INMP441                         ESP32 DevKit
   ┌───────────┐                   ┌────────────────┐
   │       VDD ├───────────────────┤ 3V3            │
   │       GND ├───────────────────┤ GND            │
   │       L/R ├───────────────────┤ GND   (left)   │
   │       SCK ├───────────────────┤ GPIO 26  BCLK  │
   │        WS ├───────────────────┤ GPIO 25  LRCLK │
   │        SD ├───────────────────┤ GPIO 33  DIN   │
   └───────────┘                   │                │
                                   │ GPIO 2 (LED)   │ ← on-board blue status LED
                                   │ GPIO 0 (BOOT)  │ ← optional pause/resume button
                                   └────────────────┘
```

| INMP441 | ESP32 | `config.h` |
|---|---|---|
| VDD | 3.3 V (**not** 5 V) | |
| GND | GND | |
| L/R | GND → left slot | `MIC_USE_RIGHT_SLOT 0` |
| SCK | GPIO 26 | `I2S_BCLK` |
| WS | GPIO 25 | `I2S_LRCLK` |
| SD | GPIO 33 | `I2S_DIN` |

Tips:
- Keep the I2S wires short (< 15 cm). Long jumper wires cause crackle.
- Most free GPIOs work. BCLK and WS are outputs, so they can't use the input-only
  GPIO 34–39; SD can. Avoid the strapping pins (0, 2, 5, 12, 15) and GPIO 6–11 (flash).
- If L/R is tied to 3.3 V instead, set `MIC_USE_RIGHT_SLOT 1`.

## Configure

1. Copy the credentials template (it's git-ignored):
   ```bash
   cp include/secrets.example.h include/secrets.h
   ```
2. Edit `include/secrets.h`:
   ```c
   #define WIFI_SSID     "MyWiFi"
   #define WIFI_PASSWORD "secret"
   #define SERVER_HOST   "192.168.1.10"   // the machine running the server
   #define SERVER_PORT   8080
   #define DEVICE_TOKEN  "same value as DEVICE_TOKEN in server/.env"
   #define DEVICE_ID     "esp32-mic-001"  // unique per microphone
   ```
3. Everything else lives in [`include/config.h`](include/config.h), and any value can
   be overridden there, in `secrets.h`, or with `build_flags` in `platformio.ini`:

| Setting | Default | Meaning |
|---|---|---|
| `I2S_BCLK` / `I2S_LRCLK` / `I2S_DIN` | 26 / 25 / 33 | Mic pins |
| `MIC_USE_RIGHT_SLOT` | 0 | 1 if L/R is tied to 3.3 V |
| `MIC_GAIN` | 6.0 | Digital gain (clipped, not wrapped) |
| `MIC_DC_BLOCK` | 1 | High-pass away the mic's DC offset |
| `AUDIO_SAMPLE_RATE` | 16000 | Must match server `SAMPLE_RATE` |
| `AUDIO_FRAME_SAMPLES` | 1024 | Samples per WebSocket frame (64 ms) |
| `AUDIO_CODEC_ADPCM` | 1 | Compress 4:1 with IMA-ADPCM (8 KB/s on the wire). 0 = raw PCM (32 KB/s) |
| `AUDIO_BUFFER_MS` | 10000 (ADPCM) / 3000 (PCM) | RAM buffer (~80 KB). Audio captured during a slow link or reconnect is kept and sent afterwards |
| `SERVER_PATH` | `/audio` | Server `DEVICE_WS_PATH` |
| `SERVER_USE_TLS` | 0 | 1 = `wss://` (needs `SERVER_ROOT_CA`) |
| `STREAM_BUTTON_PIN` | 0 | Press to pause/resume streaming; -1 disables |
| `STATUS_LED_PIN` | 2 | Blue LED: steady = Wi-Fi connected, 3 flashes + 5 s pause = not connected; -1 disables |
| `STATUS_LED_ACTIVE_HIGH` | 1 | 0 if the LED lights when the pin is LOW |
| `WDT_TIMEOUT_S` | 20 | Task watchdog timeout |
| `OFFLINE_REBOOT_MS` | 15 min | Reboot if the server is unreachable this long (0 = never) |
| `MIN_FREE_HEAP_BYTES` | 24 KB | Reboot gracefully if heap stays below this |
| `DEBUG_SERIAL` | 1 | Serial log at 115200; 0 for a silent build |

## Build and flash

### PlatformIO (recommended)

```bash
cd esp32
pio run                        # build
pio run -t upload              # flash (add --upload-port /dev/ttyUSB0 if needed)
pio device monitor             # watch the log
pio run -e esp32dev-release -t upload   # silent build, no Serial output
```

`platformio.ini` uses the [pioarduino](https://github.com/pioarduino/platform-espressif32)
platform because the firmware needs Arduino-ESP32 **3.x** (ESP-IDF 5 I2S driver);
PlatformIO's stock `espressif32` platform still ships 2.x. To pin a version
instead of `stable`, replace the URL with a specific release zip.

### Arduino CLI / Arduino IDE

Needs the `esp32` core ≥ 3.0 and the libraries **WebSockets** (Markus Sattler, ≥ 2.7.1)
and **ArduinoJson** (≥ 7).

```bash
arduino-cli core install esp32:esp32
arduino-cli lib install "WebSockets" "ArduinoJson"

# Arduino wants a sketch folder named after a .ino file:
mkdir -p build/esp32mic
cp src/*.cpp src/*.h include/*.h build/esp32mic/
echo "// sources: main.cpp, mic_i2s.cpp" > build/esp32mic/esp32mic.ino

arduino-cli compile --fqbn esp32:esp32:esp32 build/esp32mic
arduino-cli upload  --fqbn esp32:esp32:esp32 -p /dev/ttyUSB0 build/esp32mic
arduino-cli monitor -p /dev/ttyUSB0 -c baudrate=115200
```

## What a healthy boot looks like

```
[      52] ESP32 mic esp32-mic-001 (1.0.0) booting, reset reason: power_on
[      61] I2S ready: BCLK=26 WS=25 SD=33, 16000 Hz, left slot, buffer 30720 bytes
[      63] Wi-Fi connecting to "MyWiFi"
[    2410] Wi-Fi connected: IP 192.168.1.50, RSSI -52 dBm
[    2433] WebSocket connected to 192.168.1.10:8080/audio
[    2460] Server accepted hello (protocol 1)
[    2461] Streaming audio
[   10000] stats: link=3 frames=118 dropped=0B i2s_err=0 i2s_restarts=0 send_fail=0 heap=231544
```

`link` states: 0 = Wi-Fi down, 1 = WebSocket connecting, 2 = waiting for the welcome message, 3 = streaming.

## How it works

```
 core 1, prio 5                      core 1, loop()
┌───────────────────┐   30 KB     ┌──────────────────────────────────────┐
│ capture task      │  stream     │ Wi-Fi state machine (backoff)        │
│  i2s_channel_read │──buffer───▶ │ WebSocket (hello → welcome → start)  │
│  24→16 bit, DC,   │  (static)   │ drain 2 KB frames → sendBIN          │
│  gain, clip       │             │ telemetry every 5 s                  │
└───────────────────┘             │ heap / watchdog / offline checks     │
                                  └──────────────────────────────────────┘
```

- **No heap churn in the audio path.** Ring buffer, frame buffer and I2S buffers
  are all static. JSON parsing only happens for rare server control messages.
- **Back-pressure.** If Wi-Fi stalls or the connection drops, capture continues
  into the ring buffer (up to `AUDIO_BUFFER_MS`); after the reconnect the backlog
  is sent first, faster than real time. Only longer outages drop audio, in whole
  16 ms chunks (never partial samples), counted in `dropped_bytes`.
- **Reconnect.** Wi-Fi retries after 1, 2, 5, 10, then every 30 s. The WebSocket
  retry interval grows the same way the longer the server stays unreachable.
  On reconnect, buffered audio is sent first so short outages leave no gap.
- **Watchdog.** Both tasks are on the ESP-IDF task watchdog (`WDT_TIMEOUT_S`).
  I2S read errors or timeouts restart the I2S driver; if it can't be restarted,
  or free heap stays low, or the server has been unreachable for
  `OFFLINE_REBOOT_MS`, the board sends `stop`, closes the socket and reboots.
  The reset reason is reported to the server in the next `hello`.
