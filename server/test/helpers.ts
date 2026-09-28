import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createMicServer, type MicServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { parseWavHeader, type WavInfo } from '../src/wav.js';

export const TOKEN = 'test-token-0123456789abcdef';

export interface TestServer {
  mic: MicServer;
  dir: string;
  http: string;
  ws: string;
  logs: string[];
  stop(): Promise<void>;
}

export async function startServer(env: Record<string, string> = {}, dir?: string): Promise<TestServer> {
  const recordingsDir = dir ?? (await mkdtemp(path.join(os.tmpdir(), 'esp32-mic-test-')));
  const config = loadConfig({
    DEVICE_TOKEN: TOKEN,
    HOST: '127.0.0.1',
    PORT: '0',
    RECORDINGS_DIR: recordingsDir,
    AUDIO_TIMEOUT_MS: '400',
    FLUSH_INTERVAL_MS: '100',
    STATUS_INTERVAL_MS: '50',
    HELLO_TIMEOUT_MS: '1000',
    RECORDING_FORMAT: 'wav', // byte-exact WAV assertions; MP3 has its own suite
    ...env,
  });
  const logs: string[] = [];
  const mic = await createMicServer(config, createLogger('debug', (l) => logs.push(l)));
  const addr = await mic.listen();
  return {
    mic,
    dir: recordingsDir,
    http: `http://127.0.0.1:${addr.port}`,
    ws: `ws://127.0.0.1:${addr.port}`,
    logs,
    stop: () => mic.close(),
  };
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function waitFor<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 3000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A deterministic PCM frame whose content identifies the device that sent it. */
export function pcmFrame(seed: number, samples = 1024): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(((seed * 7919 + i * 31) % 60000) - 30000, i * 2);
  return b;
}

export class FakeDevice {
  ws!: WebSocket;
  messages: any[] = [];
  closeCode: number | null = null;
  sent: Buffer[] = [];

  constructor(
    readonly url: string,
    readonly id: string,
    readonly token: string | null = TOKEN,
  ) {}

  /** Open the socket. Resolves with the HTTP status if the upgrade is refused. */
  open(): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = this.token ? { Authorization: `Bearer ${this.token}` } : {};
      this.ws = new WebSocket(`${this.url}/audio`, { headers });
      this.ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? -1));
      this.ws.on('open', () => resolve(null));
      this.ws.on('error', (err) => {
        if (!/Unexpected server response/.test(err.message)) reject(err);
      });
      this.ws.on('message', (data, isBinary) => {
        if (!isBinary) this.messages.push(JSON.parse(data.toString()));
      });
      this.ws.on('close', (code) => (this.closeCode = code));
    });
  }

  async connect(hello: Record<string, unknown> = {}): Promise<void> {
    const status = await this.open();
    if (status !== null) throw new Error(`upgrade refused with ${status}`);
    this.send({
      type: 'hello',
      device_id: this.id,
      sample_rate: 16000,
      bits: 16,
      channels: 1,
      format: 'pcm_s16le',
      ip: '192.168.1.50',
      firmware: 'test',
      rssi: -48,
      ...hello,
    });
    await waitFor(() => this.messages.find((m) => m.type === 'welcome'), `${this.id} welcome`);
    this.send({ type: 'start' });
  }

  send(obj: object): void {
    this.ws.send(JSON.stringify(obj));
  }

  audio(frame: Buffer): void {
    this.sent.push(frame);
    this.ws.send(frame, { binary: true });
  }

  async stream(frames: number, seed: number, intervalMs = 5): Promise<void> {
    for (let i = 0; i < frames; i++) {
      this.audio(pcmFrame(seed + i));
      if (intervalMs) await sleep(intervalMs);
    }
  }

  get sentBytes(): Buffer {
    return Buffer.concat(this.sent);
  }

  async closed(): Promise<number> {
    return waitFor(() => this.closeCode, `${this.id} socket close`);
  }

  /** Abrupt loss (power cut / Wi-Fi drop): no close frame, no stop. */
  kill(): void {
    this.ws.terminate();
  }
}

export class Dashboard {
  ws!: WebSocket;
  messages: any[] = [];

  constructor(readonly url: string) {}

  async open(origin?: string): Promise<number | null> {
    return new Promise((resolve) => {
      this.ws = new WebSocket(`${this.url}/ws`, origin ? { origin } : {});
      this.ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? -1));
      this.ws.on('open', () => resolve(null));
      this.ws.on('error', () => {});
      this.ws.on('message', (d) => this.messages.push(JSON.parse(d.toString())));
    });
  }

  statuses(id: string): any[] {
    return this.messages.filter((m) => m.type === 'status' && m.device_id === id);
  }

  close(): void {
    this.ws.close();
  }
}

export interface ReadWav {
  info: WavInfo;
  size: number;
  data: Buffer;
}

export async function readWav(file: string): Promise<ReadWav> {
  const buf = await readFile(file);
  const info = parseWavHeader(buf);
  if (!info) throw new Error(`${file} is not a WAV file`);
  return { info, size: buf.length, data: buf.subarray(info.dataOffset) };
}
