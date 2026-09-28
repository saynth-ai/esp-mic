/**
 * Pretend to be an ESP32 microphone: connect, hello, start, then stream a sine
 * tone as 16-bit PCM in real time. Useful for testing the server without hardware.
 *
 *   npm run simulate -- --token <DEVICE_TOKEN> [--url ws://localhost:8080/audio]
 *                       [--id esp32-sim-001] [--seconds 10] [--freq 440] [--frame 1024] [--adpcm]
 *
 * --seconds 0 streams until Ctrl+C. Ctrl+C sends {"type":"stop"} first.
 */
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { AdpcmEncoder } from '../src/adpcm.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.SIM_URL ?? 'ws://localhost:8080/audio' },
    token: { type: 'string', default: process.env.DEVICE_TOKEN ?? '' },
    id: { type: 'string', default: 'esp32-sim-001' },
    seconds: { type: 'string', default: '10' },
    freq: { type: 'string', default: '440' },
    rate: { type: 'string', default: '16000' },
    frame: { type: 'string', default: '1024' },
    adpcm: { type: 'boolean', default: false },
  },
});

const sampleRate = Number(values.rate);
const frameSamples = Number(values.frame);
const seconds = Number(values.seconds);
const freq = Number(values.freq);
const frameMs = (frameSamples / sampleRate) * 1000;

const ws = new WebSocket(values.url, { headers: { Authorization: `Bearer ${values.token}` } });
let phase = 0;
let sent = 0;
let timer: NodeJS.Timeout | null = null;
const encoder = values.adpcm ? new AdpcmEncoder() : null;

function frame(): Buffer {
  const pcm = new Int16Array(frameSamples);
  for (let i = 0; i < frameSamples; i++) {
    pcm[i] = Math.round(Math.sin(phase) * 8000);
    phase += (2 * Math.PI * freq) / sampleRate;
  }
  phase %= 2 * Math.PI;
  return encoder ? encoder.encode(pcm) : Buffer.from(pcm.buffer);
}

function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stop' }));
    ws.close(1000, 'simulation finished');
  }
}

ws.on('unexpected-response', (_req, res) => {
  console.error(`Server refused the connection: HTTP ${res.statusCode}${res.statusCode === 401 ? ' (bad token?)' : ''}`);
  process.exit(1);
});

ws.on('open', () => {
  ws.send(
    JSON.stringify({
      type: 'hello',
      device_id: values.id,
      sample_rate: sampleRate,
      bits: 16,
      channels: 1,
      format: values.adpcm ? 'ima_adpcm' : 'pcm_s16le',
      frame_samples: frameSamples,
      firmware: 'simulator',
      ip: '127.0.0.1',
      rssi: -50,
    }),
  );
});

ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  const msg = JSON.parse(data.toString());
  if (msg.type === 'welcome') {
    console.log(`Connected as ${values.id}; streaming ${freq} Hz tone${seconds > 0 ? ` for ${seconds}s` : ''}`);
    ws.send(JSON.stringify({ type: 'start' }));
    const started = Date.now();
    timer = setInterval(() => {
      // Catch up if the timer fell behind, like the ESP32 draining its buffer.
      const due = Math.floor((Date.now() - started) / frameMs);
      while (sent < due) {
        ws.send(frame(), { binary: true });
        sent++;
      }
      if (seconds > 0 && Date.now() - started >= seconds * 1000) stop();
    }, frameMs / 2);
  } else if (msg.type === 'error') {
    console.error(`Server error: ${msg.message}`);
  }
});

ws.on('close', (code, reason) => {
  console.log(`Disconnected (${code}${reason.length ? ` ${reason}` : ''}); sent ${sent} frames`);
  if (timer) clearInterval(timer);
  process.exit(code === 1000 ? 0 : 1);
});

ws.on('error', (err) => console.error(`WebSocket error: ${err.message}`));
process.on('SIGINT', stop);
