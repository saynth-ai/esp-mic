#pragma once
//
// ESP32 Wi-Fi microphone — build configuration.
//
// Credentials belong in include/secrets.h (git-ignored; copy secrets.example.h).
// Every value below can also be overridden from platformio.ini build_flags,
// e.g.  -D SERVER_PORT=9000  or  -D 'SERVER_HOST="10.0.0.5"'
//

#if __has_include("secrets.h")
#include "secrets.h"
#endif

// ----------------------------------------------------------------- identity
#ifndef DEVICE_ID
#define DEVICE_ID "esp32-mic-001"          // [A-Za-z0-9_-], max 64 chars, unique per mic
#endif
#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "1.0.0"
#endif

// ------------------------------------------------------------------- Wi-Fi
#ifndef WIFI_SSID
#define WIFI_SSID "your-wifi-ssid"
#endif
#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD "your-wifi-password"
#endif
// Optional extra networks (define in secrets.h): the strongest known one in range
// is joined. #define WIFI_SSID_2 "..." / WIFI_PASSWORD_2 "...", same for _3.

// Wi-Fi transmit power. Lower it (e.g. WIFI_POWER_8_5dBm) on boards whose 3.3 V
// regulator browns out during transmit bursts. Values: WIFI_POWER_19_5dBm (max) … WIFI_POWER_2dBm
#ifndef WIFI_TX_POWER
#define WIFI_TX_POWER WIFI_POWER_19_5dBm
#endif

// ------------------------------------------------------------------ server
#ifndef SERVER_HOST
#define SERVER_HOST "192.168.1.10"         // IP or hostname of the Node.js server
#endif
#ifndef SERVER_PORT
#define SERVER_PORT 8080
#endif
#ifndef SERVER_PATH
#define SERVER_PATH "/audio"
#endif
#ifndef DEVICE_TOKEN
#define DEVICE_TOKEN "change-this-token"   // must match DEVICE_TOKEN in server/.env
#endif
// 1 = wss:// (e.g. behind Caddy/nginx with a real certificate). Requires SERVER_ROOT_CA.
#ifndef SERVER_USE_TLS
#define SERVER_USE_TLS 0
#endif
// PEM of the CA(s) that signed the server certificate (only used when SERVER_USE_TLS=1).
// Defaults to the public roots in ca_roots.h, which cover Cloudflare-proxied hosts
// (Google Trust Services, GlobalSign, Let's Encrypt).
#if SERVER_USE_TLS && !defined(SERVER_ROOT_CA)
#include "ca_roots.h"
#define SERVER_ROOT_CA kPublicRootCAs
#endif

// ------------------------------------------------------------ INMP441 / I2S
#ifndef I2S_BCLK
#define I2S_BCLK 26                        // INMP441 SCK
#endif
#ifndef I2S_LRCLK
#define I2S_LRCLK 25                       // INMP441 WS
#endif
#ifndef I2S_DIN
#define I2S_DIN 33                         // INMP441 SD
#endif
// INMP441 L/R pin: GND → left slot (0), 3.3V → right slot (1).
// If you record pure silence, flip this first.
#ifndef MIC_USE_RIGHT_SLOT
#define MIC_USE_RIGHT_SLOT 0
#endif

// ------------------------------------------------------------------- audio
// The server validates these; changing the rate needs SAMPLE_RATE on the server too.
#ifndef AUDIO_SAMPLE_RATE
#define AUDIO_SAMPLE_RATE 16000
#endif
// Samples per WebSocket binary frame. 1024 @ 16 kHz = 64 ms, 2 KB per frame.
#ifndef AUDIO_FRAME_SAMPLES
#define AUDIO_FRAME_SAMPLES 1024
#endif
// Compress audio on the device with IMA-ADPCM (4:1): 32 KB/s of PCM becomes ~8 KB/s
// on the wire. Much more robust on weak or lossy links; the server decodes it back to
// 16-bit PCM, so recordings are unchanged. Slightly lossy (fine for speech). 0 = raw PCM.
#ifndef AUDIO_CODEC_ADPCM
#define AUDIO_CODEC_ADPCM 1
#endif

// RAM ring buffer between the I2S task and the network. Audio captured while the
// link is slow or reconnecting waits here and is sent afterwards; only an outage
// longer than this loses audio (the newest frames are dropped). ADPCM: 6 s ≈ 48 KB;
// raw PCM 3 s ≈ 94 KB. With SERVER_USE_TLS keep ≥ ~80 KB heap free for TLS.
#ifndef AUDIO_BUFFER_MS
#if AUDIO_CODEC_ADPCM
#define AUDIO_BUFFER_MS 6000               // ~48 KB: leaves room for TLS (wss) buffers
#else
#define AUDIO_BUFFER_MS 3000
#endif
#endif
// Linear gain applied after the DC-blocking filter (fixed, or the AGC's starting
// value). The INMP441 is quiet at unity gain; 4-8 suits speech at 0.5-2 m.
#ifndef MIC_GAIN
#define MIC_GAIN 6.0f
#endif
// Automatic gain control (see mic_i2s.cpp). When on, MIC_GAIN is only the starting gain.
#ifndef MIC_AGC
#define MIC_AGC 1
#endif
#ifndef AGC_TARGET_DBFS
#define AGC_TARGET_DBFS -22.0f             // speech level to aim for (RMS, dB full scale)
#endif
#ifndef AGC_MAX_GAIN
#define AGC_MAX_GAIN 20.0f                 // +26 dB; caps how much quiet speech is boosted
#endif
#ifndef AGC_MIN_GAIN
#define AGC_MIN_GAIN 1.0f
#endif

// Remove the INMP441's DC offset with a first-order high-pass (~20 Hz).
#ifndef MIC_DC_BLOCK
#define MIC_DC_BLOCK 1
#endif

// Optional push button to pause/resume streaming (sends stop/start). GPIO0 is
// the BOOT button on most dev boards. -1 disables it.
#ifndef STREAM_BUTTON_PIN
#define STREAM_BUTTON_PIN 0
#endif

// Status LED (the blue on-board LED is GPIO 2 on most ESP32 DevKits; -1 disables).
//   Wi-Fi connected      → steady on
//   Wi-Fi not connected  → 3 quick flashes, 5 s pause, repeat
#ifndef STATUS_LED_PIN
#define STATUS_LED_PIN 2
#endif
#ifndef STATUS_LED_ACTIVE_HIGH
#define STATUS_LED_ACTIVE_HIGH 1           // 0 if your LED lights when the pin is LOW
#endif

// ------------------------------------------------------------- reliability
#ifndef WDT_TIMEOUT_S
#define WDT_TIMEOUT_S 20                   // task watchdog: reboot if a task hangs this long
#endif
#ifndef WIFI_CONNECT_TIMEOUT_MS
#define WIFI_CONNECT_TIMEOUT_MS 20000      // give up on one association attempt after this
#endif
#ifndef WS_HANDSHAKE_TIMEOUT_MS
#define WS_HANDSHAKE_TIMEOUT_MS 8000       // hello sent → no welcome → reconnect
#endif
#ifndef OFFLINE_REBOOT_MS
#define OFFLINE_REBOOT_MS (15UL * 60UL * 1000UL)   // no server link this long → reboot (0 = never)
#endif
#ifndef SERVER_OFFLINE_REBOOT_MS
#define SERVER_OFFLINE_REBOOT_MS 120000    // Wi-Fi up but server unreachable this long → clean reboot (0 = never)
#endif
#ifndef WS_CONNECT_STUCK_MS
#define WS_CONNECT_STUCK_MS 15000          // connecting longer than retry interval + this → reset the attempt
#endif
#ifndef WS_SEND_STALL_MS
#define WS_SEND_STALL_MS 2000              // one frame taking longer than this = link stalled → reconnect
#endif
#ifndef MIN_FREE_HEAP_BYTES
#define MIN_FREE_HEAP_BYTES (24 * 1024)    // below this for 10 s → graceful reboot
#endif
#ifndef TELEMETRY_INTERVAL_MS
#define TELEMETRY_INTERVAL_MS 5000
#endif

// Serial logging (115200 baud). Set to 0 for a silent production build.
#ifndef DEBUG_SERIAL
#define DEBUG_SERIAL 1
#endif
