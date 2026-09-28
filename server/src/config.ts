import path from 'node:path';

/** PCM stream format every device must send. Only the sample rate is tunable. */
export interface AudioFormat {
  sampleRate: number;
  bitsPerSample: 16;
  channels: 1;
  /** Wire-format name used in the device hello message. */
  format: 'pcm_s16le';
}

export interface Config {
  host: string;
  port: number;
  /** Absolute path; the only directory recordings are ever read from or written to. */
  recordingsDir: string;
  /** Accepted device tokens. More than one allows zero-downtime token rotation. */
  deviceTokens: string[];
  audio: AudioFormat;
  /** No audio for this long → the current recording is finalized. */
  audioTimeoutMs: number;
  /** A device must send its hello within this long after the WebSocket opens. */
  helloTimeoutMs: number;
  /** How often buffered audio is written and the WAV header is patched + fsynced. */
  flushIntervalMs: number;
  /** Server → device WebSocket ping interval; two missed pongs = dead connection. */
  pingIntervalMs: number;
  /** Minimum spacing between dashboard status pushes for one device while audio flows. */
  statusIntervalMs: number;
  /** Recordings are split into a new file after this many seconds (0 = never, capped by the 4 GB WAV limit). */
  maxRecordingSeconds: number;
  /** Finished recordings are stored as MP3 (converted with LAME) or kept as WAV. */
  recordingFormat: 'mp3' | 'wav';
  mp3BitrateKbps: number;
  lamePath: string;
  /** Largest accepted binary frame. */
  maxFrameBytes: number;
  /** '*' = any origin; empty list = same-origin only. */
  corsOrigins: '*' | string[];
  /** Honour X-Forwarded-For when behind a reverse proxy. */
  trustProxy: boolean;
  devicePath: string;
  dashboardPath: string;
  /** Browsers listen to a device's live audio here: <livePath>?device=<id> */
  livePath: string;
  logLevel: LogLevel;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class ConfigError extends Error {}

const EXAMPLE_TOKEN = 'change-this-token';

function int(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${key} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

function bool(env: NodeJS.ProcessEnv, key: string, def: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return def;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${key} must be true or false (got "${env[key]}")`);
}

function list(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function urlPath(env: NodeJS.ProcessEnv, key: string, def: string): string {
  const p = env[key]?.trim() || def;
  if (!/^\/[A-Za-z0-9/_-]*$/.test(p)) throw new ConfigError(`${key} must be a URL path like ${def}`);
  return p;
}

// Bitrates valid for MPEG-2 Layer III, which is what 16-24 kHz audio is encoded as.
const MP3_BITRATES = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

function recordingFormat(env: NodeJS.ProcessEnv): 'mp3' | 'wav' {
  const f = (env.RECORDING_FORMAT?.trim().toLowerCase() || 'mp3') as 'mp3' | 'wav';
  if (f !== 'mp3' && f !== 'wav') throw new ConfigError('RECORDING_FORMAT must be mp3 or wav');
  return f;
}

function mp3Bitrate(env: NodeJS.ProcessEnv): number {
  const b = int(env, 'MP3_BITRATE', 32, 8, 160);
  if (!MP3_BITRATES.includes(b)) throw new ConfigError(`MP3_BITRATE must be one of ${MP3_BITRATES.join(', ')}`);
  return b;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const deviceTokens = list(env.DEVICE_TOKEN);
  if (deviceTokens.length === 0) {
    throw new ConfigError('DEVICE_TOKEN is required (comma-separate several to rotate tokens)');
  }

  const cors = env.CORS_ORIGINS?.trim() ?? '';
  const logLevel = (env.LOG_LEVEL?.trim().toLowerCase() || 'info') as LogLevel;
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new ConfigError('LOG_LEVEL must be debug, info, warn or error');
  }

  const config: Config = {
    host: env.HOST?.trim() || '0.0.0.0',
    port: int(env, 'PORT', 8080, 0, 65535),
    recordingsDir: path.resolve(env.RECORDINGS_DIR?.trim() || './recordings'),
    deviceTokens,
    audio: {
      sampleRate: int(env, 'SAMPLE_RATE', 16000, 8000, 48000),
      bitsPerSample: 16,
      channels: 1,
      format: 'pcm_s16le',
    },
    audioTimeoutMs: int(env, 'AUDIO_TIMEOUT_MS', 3000, 100, 600_000),
    helloTimeoutMs: int(env, 'HELLO_TIMEOUT_MS', 5000, 100, 60_000),
    flushIntervalMs: int(env, 'FLUSH_INTERVAL_MS', 1000, 50, 60_000),
    pingIntervalMs: int(env, 'PING_INTERVAL_MS', 10_000, 100, 300_000),
    statusIntervalMs: int(env, 'STATUS_INTERVAL_MS', 250, 50, 10_000),
    maxRecordingSeconds: int(env, 'MAX_RECORDING_SECONDS', 3600, 0, 24 * 3600),
    maxFrameBytes: int(env, 'MAX_FRAME_BYTES', 64 * 1024, 64, 1024 * 1024),
    recordingFormat: recordingFormat(env),
    mp3BitrateKbps: mp3Bitrate(env),
    lamePath: env.LAME_PATH?.trim() || 'lame',
    corsOrigins: cors === '*' ? '*' : list(cors),
    trustProxy: bool(env, 'TRUST_PROXY', false),
    devicePath: urlPath(env, 'DEVICE_WS_PATH', '/audio'),
    dashboardPath: '/ws', // public/app.js connects here
    livePath: '/ws/live',
    logLevel,
  };

  if (config.devicePath === config.dashboardPath || config.devicePath === config.livePath) {
    throw new ConfigError(`DEVICE_WS_PATH cannot be ${config.dashboardPath} or ${config.livePath} (used by the dashboard)`);
  }
  return config;
}

/** Human-readable problems that should not stop startup but must be seen. */
export function configWarnings(config: Config): string[] {
  const warnings: string[] = [];
  for (const t of config.deviceTokens) {
    if (t === EXAMPLE_TOKEN) warnings.push('DEVICE_TOKEN is still the example value — set a random secret');
    else if (t.length < 16) warnings.push('DEVICE_TOKEN is shorter than 16 characters — use a longer random secret');
  }
  if (config.corsOrigins === '*') warnings.push('CORS_ORIGINS=* allows any website to read the API');
  return warnings;
}
