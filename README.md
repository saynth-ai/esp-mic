# ESP32 Wi-Fi Microphone Recorder

An ESP32 + INMP441 microphone streams raw 16 kHz / 16-bit / mono PCM over a
WebSocket to a Node.js server. The server records every session to its own WAV
file and shows everything live on a web dashboard.

```
 INMP441 ──I2S──▶ ESP32 ──Wi-Fi / WebSocket (binary PCM)──▶ Node.js server ──▶ ./recordings/*.wav
                                                                 │
                                    browser dashboard ◀──WebSocket (live status)
```

- **Automatic recording.** A file opens on the first audio frame. It closes on
  `stop`, on disconnect, or after `AUDIO_TIMEOUT_MS` of silence on the wire.
- **Crash-safe WAV files.** The header is patched and fsynced every second,
  so a crash loses at most about 1 s of audio. Any leftover inconsistent
  headers are repaired at startup.
- **ADPCM on the wire.** The ESP32 compresses audio 4:1 (IMA-ADPCM, 8 KB/s
  instead of 32 KB/s), so it survives weak or lossy Wi-Fi; the server decodes
  it back to 16-bit PCM before recording.
- **Compact MP3 storage.** Finished recordings are converted to MP3 (32 kbps,
  ~14 MB/hour instead of ~115 MB/hour for WAV) in the background.
- **Multiple microphones.** Each `device_id` gets its own files, and names are
  never reused.
- **Token authentication.** Checked before the WebSocket upgrade. The audio
  format is validated in the hello, and path traversal is refused.
- **Robust firmware.** Wi-Fi and WebSocket reconnect with backoff; the task
  watchdog, I2S recovery, heap monitoring, and static buffers cover the rest.

```
esp32-mic/
├── esp32/                     firmware (PlatformIO / Arduino-ESP32 3.x)
│   ├── include/config.h       all pins, audio and reliability settings
│   ├── include/secrets.example.h
│   ├── src/main.cpp           Wi-Fi, WebSocket, streaming, watchdog
│   ├── src/mic_i2s.{h,cpp}    INMP441 capture (I2S std driver)
│   ├── platformio.ini
│   └── README.md              wiring diagram, build/flash, internals
└── server/                    Node.js + TypeScript
    ├── src/
    │   ├── server.ts          entry point, signals, graceful shutdown
    │   ├── app.ts             Express app + REST routes
    │   ├── websocket.ts       device + dashboard WebSockets
    │   ├── devices.ts         device state manager + recording lifecycle
    │   ├── recorder.ts        streaming WAV writer
    │   ├── recordings.ts      listing, safe paths, crash repair
    │   ├── protocol.ts        message parsing / validation
    │   ├── wav.ts             WAV header build/parse
    │   ├── auth.ts, cors.ts, config.ts, logger.ts
    ├── public/                dashboard (index.html, app.js, style.css)
    ├── tools/simulate-device.ts   fake ESP32 for testing without hardware
    ├── test/                  acceptance + unit tests (node:test)
    ├── recordings/            WAV output (bind-mounted in Docker)
    ├── Dockerfile, docker-compose.yml, .env.example
```

---

## 1. Start the server

### With Docker (recommended)

```bash
cd server
cp .env.example .env
# set a real secret:
sed -i "s/^DEVICE_TOKEN=.*/DEVICE_TOKEN=$(openssl rand -hex 24)/" .env
grep DEVICE_TOKEN .env            # you'll paste this into the firmware

mkdir -p recordings
sudo chown 1000:1000 recordings   # the container runs as uid 1000 (see below)
docker compose up -d --build
docker compose logs -f
```

Open **http://SERVER_IP:8080**.

Recordings are written to `server/recordings/` on the host. That directory is
bind-mounted at `/app/recordings`, so files survive rebuilds and restarts. The
container runs as uid:gid 1000:1000 by default. If your `recordings/` folder is
owned by someone else, either `chown` it or run with
`APP_UID=$(id -u) APP_GID=$(id -g) docker compose up -d`. To publish on another
host port, use `HOST_PORT=9000 docker compose up -d`.

`docker compose down` sends SIGTERM. The server finalizes open recordings before
exiting, with a 15 s grace period.

### Without Docker

Requires Node.js ≥ 20.12.

```bash
cd server
cp .env.example .env              # set DEVICE_TOKEN
npm install
npm run build
npm start                         # production (dist/)
# or: npm run dev                 # watch mode with tsx
```

### Try it without hardware

```bash
cd server
npm run simulate -- --token "$(grep ^DEVICE_TOKEN .env | cut -d= -f2)" --seconds 10
npm run simulate -- --token ... --id esp32-mic-002 --seconds 0   # until Ctrl+C
```

The simulator streams a sine tone in real time, speaking the exact device
protocol. Watch it appear on the dashboard and in `recordings/`.

## 2. Flash the ESP32

See [`esp32/README.md`](esp32/README.md) for the wiring diagram and details.

```bash
cd esp32
cp include/secrets.example.h include/secrets.h   # Wi-Fi, SERVER_HOST, DEVICE_TOKEN, DEVICE_ID
pio run -t upload && pio device monitor
```

Within a few seconds of boot the dashboard shows the device as **CONNECTED**
and **STREAMING**, and a new WAV appears in the recordings list.

Wiring summary (INMP441 → ESP32): VDD→3V3, GND→GND, L/R→GND, SCK→GPIO26, WS→GPIO25, SD→GPIO33.

---

## Configuration (server `.env`)

| Variable | Default | Description |
|---|---|---|
| `DEVICE_TOKEN` | *(required)* | Shared device secret. Comma-separate several to rotate. |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / *(empty)* | Fixed dashboard login. Empty password = no login (development only) |
| `SESSION_SECRET` | *(empty)* | Random secret that signs session cookies |
| `SESSION_TTL_HOURS` | `168` | How long a login lasts |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | Listen address |
| `RECORDINGS_DIR` | `./recordings` | Only directory files are written to or served from |
| `TZ` | system | Timezone for filenames |
| `AUDIO_TIMEOUT_MS` | `3000` | Silence on the wire before the recording is closed |
| `FLUSH_INTERVAL_MS` | `1000` | Disk write + header fsync interval (max loss on crash) |
| `MAX_RECORDING_SECONDS` | `3600` | Roll over to a new file after this long (0 = never) |
| `RECORDING_FORMAT` | `mp3` | `mp3`: finished WAVs are converted with LAME and deleted. `wav`: keep WAV |
| `MP3_BITRATE` | `32` | kbps CBR. 16/24 for speech-only archives, 48/64 for music |
| `LAME_PATH` | `lame` | Encoder binary. If it's missing the server logs an error and keeps WAV |
| `SAMPLE_RATE` | `16000` | Must match the firmware |
| `MAX_FRAME_BYTES` | `65536` | Largest accepted binary frame |
| `CORS_ORIGINS` | *(empty)* | Extra allowed origins (`*` for any). Same-origin always works. |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For` for client IPs |
| `DEVICE_WS_PATH` | `/audio` | Device WebSocket path (`SERVER_PATH` in firmware) |
| `HELLO_TIMEOUT_MS` | `5000` | Close sockets that don't identify themselves |
| `PING_INTERVAL_MS` | `10000` | Heartbeat; 2 missed pongs → connection dropped |
| `STATUS_INTERVAL_MS` | `250` | Max dashboard update rate per device while streaming |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## WebSocket protocol (device ⇄ server)

Endpoint: `ws://SERVER:8080/audio`. The token goes in the upgrade request
header, never in the URL:

```http
GET /audio HTTP/1.1
Upgrade: websocket
Authorization: Bearer <DEVICE_TOKEN>        (or  X-Device-Token: <DEVICE_TOKEN>)
```

A wrong or missing token gets `HTTP 401` and the socket is never opened.

```text
device → {"type":"hello","device_id":"esp32-mic-001","sample_rate":16000,"bits":16,
          "channels":1,"format":"pcm_s16le","firmware":"1.0.0","ip":"192.168.1.50",
          "mac":"AA:BB:CC:DD:EE:FF","rssi":-52,"reset_reason":"power_on"}
server → {"type":"welcome","protocol":1,"device_id":"esp32-mic-001","sample_rate":16000,
          "audio_timeout_ms":3000,"max_frame_bytes":65536,"server_time":"…"}
device → {"type":"start"}
device → [binary: 2048 bytes = 1024 samples s16le]      ← repeated every 64 ms
          (or, with "format":"ima_adpcm", 516-byte ADPCM blocks — see below)
device → [binary …]
device → {"type":"telemetry","rssi":-53,"free_heap":231544,"min_free_heap":226000,
          "uptime_s":3600,"dropped_bytes":0,"i2s_errors":0,"frames_sent":56250}   ← every 5 s
device → {"type":"stop"}
```

**IMA-ADPCM frames** (`"format":"ima_adpcm"`, `"frame_samples":N` in the hello, N even):
each binary frame is one self-contained block of N samples, `4 + N/2` bytes (516 for N=1024):

| bytes | content |
|---|---|
| 0–1 | first sample, int16 LE (verbatim) |
| 2 | step index 0–88 at block start |
| 3 | reserved (0) |
| 4… | samples 1…N-1 as 4-bit IMA codes, low nibble first |

Blocks decode independently, so a lost block never corrupts the next. The server
decodes to 16-bit PCM immediately; recordings, MP3s and live listening are PCM as usual.
`bytes_received` counts bytes on the wire. The encoder (`esp32/src/adpcm.cpp`) and the
server decoder are tested bit-for-bit against each other.

Rules the server enforces:

- Binary frames are PCM and nothing else. They are never decoded as text.
  A frame must be non-empty, an even length, and ≤ `MAX_FRAME_BYTES`. Odd-sized
  frames are dropped and counted, so later samples stay aligned.
- `hello` must come first, within `HELLO_TIMEOUT_MS`. Its `sample_rate`, `bits`
  and `channels` must match the server and `format` must be `pcm_s16le` or
  `ima_adpcm` (with a valid `frame_samples`), otherwise the server sends an error
  and closes with 4003.
- `device_id` must match `[A-Za-z0-9_-]{1,64}`, because it becomes part of a filename.
- A second connection with the same `device_id` replaces the first (close 4004).
  This is what happens when a board reboots before its old TCP connection has timed out.
- If the byte rate stays above 1.5× the declared rate for 10 s, a
  `rate_warning` is raised. That usually means the device's sample rate is misconfigured.

Close codes: `4002` protocol error, `4003` unsupported format, `4004` replaced, `4005` no hello.

Server → dashboard (`/ws`) messages: `snapshot` on connect, then `status`
(one per device change, throttled to `STATUS_INTERVAL_MS`) and `recordings`
(when a file starts or is finalized).

```json
{"type":"status","device_id":"esp32-mic-001","connected":true,"streaming":true,"recording":true,
 "wifi":"connected","wifi_rssi":-52,"ip":"192.168.1.50","sample_rate":16000,
 "current_recording":"esp32-mic-001_2026-09-28_11-30-45.wav","recording_duration":23,
 "recording_bytes":736044,"bytes_received":1234567,"packets_received":1205,
 "last_packet":"2026-09-28T05:30:45.120Z", "...": "…"}
```

## HTTP API

| Route | Description |
|---|---|
| `GET /` | Dashboard (login required when `ADMIN_PASSWORD` is set) |
| `GET /login`, `POST /login`, `POST /logout` | Admin sign-in / sign-out |
| `GET /api/health` | `{"status":"ok","uptime":12345,"devices_connected":1,"recordings":42,"version":"1.0.0"}` |
| `GET /api/devices` | All devices seen since startup, with their live state |
| `GET /api/devices/:id` | One device |
| `GET /recordings` (alias `/api/recordings`) | `{"recordings":[{filename, device_id, started_at, duration_seconds, size_bytes, active}], "storage":{…}}` |
| `GET /recordings/:filename` | The recording (`audio/mpeg` or `audio/wav`, supports `Range` for seeking) |
| `GET /recordings/:filename?download=1` | Same, as an attachment |

Filenames are checked against a strict whitelist
(`^[A-Za-z0-9][A-Za-z0-9_-]*\.(wav|mp3)$`). The resolved path must also sit directly
inside `RECORDINGS_DIR`, so `../`, absolute paths, encoded slashes and dotfiles
are all refused.

## Recording lifecycle

| Event | What happens |
|---|---|
| First binary frame after hello | New file `<device_id>_<YYYY-MM-DD_HH-mm-ss>.wav` (`_1`, `_2`… if taken). Log: `Recording started` |
| Frames keep arriving | Buffered; written at 64 KB or every `FLUSH_INTERVAL_MS`, header patched + fsynced |
| `{"type":"stop"}` | File finalized; socket stays open. The next audio starts a new file. |
| No audio for `AUDIO_TIMEOUT_MS` | File finalized. Dashboard shows **CONNECTED · NO AUDIO** |
| Socket closes / heartbeat lost | File finalized. Dashboard shows **DISCONNECTED** |
| `MAX_RECORDING_SECONDS` reached | File finalized and a new one opened, with no gap in the audio |
| SIGTERM / SIGINT | All files finalized, sockets closed, then exit |
| Crash / power loss | On the next start, stale headers are rewritten to match the data on disk |
| File finalized (`RECORDING_FORMAT=mp3`) | Converted to `<name>.mp3` in the background (one at a time), then the WAV is deleted. Log: `Converted to MP3` |
| Crash during / before conversion | The WAV survives; half-written `.mp3.part` files are removed and the WAV is converted at the next start |

## Tests

```bash
cd server
npm test
```

59 tests run the real server (HTTP, both WebSockets, real files) against
simulated devices. They cover every acceptance scenario:

| # | Scenario | Test |
|---|---|---|
| 1–2 | ESP32 connects, WebSocket accepted | `1+2. ESP32 connects…` |
| 3–4 | Audio auto-starts a recording, WAV created | `3+4. audio starts recording automatically…` |
| 5 | Continuous streaming, periodic flush to disk | `5. audio keeps streaming…` |
| 6 | Dashboard updates in real time | `6. dashboard receives real-time status pushes` |
| 7–8 | Abrupt disconnect, WAV finalized byte-exact | `7+8. abrupt disconnect finalizes…` |
| 9–10 | Reconnect creates a new recording | `9+10. device reconnects…` |
| 11 | Server restart keeps recordings | `11. recordings survive a server restart` |
| 12 | Play (with Range) / download | `12. browser can play…` |
| 13 | Invalid / missing token rejected | `13. invalid or missing device token…` |
| 14 | Two devices at once, no overwrites | `14. multiple devices record simultaneously…` |

Also covered: the inactivity timeout with the socket still open, file
rollover, format rejection, audio before hello, hello timeout, odd frames,
duplicate `device_id`, path traversal, CORS on the dashboard socket, crash
header repair, write-error handling, and MP3 conversion (live WAV → MP3,
leftover conversion after a crash, encoder missing → WAV fallback).

## Production deployment

See [`deploy/DEPLOY.md`](deploy/DEPLOY.md): Docker image tarball, production compose
file, nginx site config for a Cloudflare-proxied domain, and `wss://` device setup
(the firmware ships the public root CAs in `esp32/include/ca_roots.h`).

## Troubleshooting

**Device never appears on the dashboard**
- Serial log stuck at `Wi-Fi connecting`: wrong SSID/password, or a 5 GHz-only
  network (the ESP32 is 2.4 GHz only).
- `WebSocket connected` never printed: check `SERVER_HOST`/`SERVER_PORT` and
  the firewall (`sudo ufw allow 8080/tcp`). From another machine, run
  `curl http://SERVER_IP:8080/api/health`.
- Server log shows `Rejected device connection … invalid or missing token`:
  `DEVICE_TOKEN` differs between `secrets.h` and `.env`.
- Server log shows `unsupported audio format`: `AUDIO_SAMPLE_RATE` (firmware)
  ≠ `SAMPLE_RATE` (server).

**Recording is silent (flat line)**
- L/R pin and `MIC_USE_RIGHT_SLOT` disagree. Flip `MIC_USE_RIGHT_SLOT`.
- SD and SCK/WS swapped, or VDD on 5 V. Recheck the wiring table.

**Recording is too quiet / clipped**: raise or lower `MIC_GAIN` (default 6).

**Crackles, pops or gaps**
- Dashboard shows *Device dropped … of audio*: Wi-Fi throughput is too low.
  Move closer to the AP (RSSI better than −70 dBm), or raise `AUDIO_BUFFER_MS`.
- Long jumper wires on the I2S lines. Keep them under 15 cm.
- Brown-outs (reset reason `brownout` on the dashboard): use a better USB
  cable or power supply.

**Recording splits into many short files**: the network pauses for longer
than `AUDIO_TIMEOUT_MS`. Raise it, e.g. `AUDIO_TIMEOUT_MS=10000`.

**Docker: `EACCES` on `/app/recordings`**: the host `recordings/` directory
isn't writable by uid 1000. Run `sudo chown 1000:1000 server/recordings`, or set
`APP_UID`/`APP_GID`.

**Dashboard shows "Reconnecting"**: the browser lost its WebSocket to the
server. It retries automatically. Behind a reverse proxy, make sure `/ws` and
`/audio` forward the `Upgrade` and `Connection` headers.

**Dashboard IP shows the proxy or Docker gateway**: the device reports its own
IP in `hello`, and that is what's shown. `remote_address` is the socket peer;
set `TRUST_PROXY=true` behind a proxy.

## Security notes

- Devices authenticate with a bearer token at the WebSocket upgrade, using a
  constant-time comparison. Use a long random token and rotate it by listing
  both old and new values: `DEVICE_TOKEN=new,old`.
- Plain `ws://` sends audio and the token unencrypted over your LAN. For
  anything beyond a trusted LAN, put the server behind a TLS proxy
  (Caddy, nginx) and build the firmware with `SERVER_USE_TLS 1` and `SERVER_ROOT_CA`.
- **Dashboard login:** set `ADMIN_PASSWORD` (and `SESSION_SECRET`). The dashboard,
  API, recordings and browser WebSockets then require a signed, HttpOnly session
  cookie; 10 failed logins per IP block logins for 15 minutes. Devices keep using
  `DEVICE_TOKEN`. Without `ADMIN_PASSWORD` the server logs a warning and stays open.
- Responses carry a strict CSP (`default-src 'self'`), `nosniff` and `X-Frame-Options: DENY`.
  CORS is off unless `CORS_ORIGINS` is set.

## Extending

The pieces are separated so later features plug in without touching the core:

- **Live processing (VAD, STT, Whisper, Deepgram, OpenAI Realtime, live
  monitoring).** Subscribe to `devices.on('audio', (deviceId, pcm) => …)` in
  `app.ts`. It receives every validated PCM frame.
- **Post-processing.** `devices.on('recordingSaved', (deviceId, rec) => …)`
  fires with the finished file's path and duration.
- **Per-device tokens / registration.** Replace `isValidDeviceToken()` in
  `auth.ts`; it already sits in the upgrade path.
- **Device naming, waveform, MQTT management, OTA.** Add fields to
  `DeviceStatus` and new message types in `protocol.ts`. The dashboard renders
  from the `status` stream.
