/**
 * Device ⇄ server protocol on the /audio WebSocket.
 *
 *   device → server  text   {"type":"hello", device_id, sample_rate, bits, channels, format, ...}
 *   server → device  text   {"type":"welcome", ...}            (or an error + close)
 *   device → server  text   {"type":"start"}
 *   device → server  binary raw PCM s16le mono frames          (repeated)
 *   device → server  text   {"type":"telemetry", rssi, free_heap, ...}   (optional, periodic)
 *   device → server  text   {"type":"stop"}
 *
 * Audio is only ever carried in binary frames; text frames are JSON control messages.
 */
import { ADPCM_FORMAT } from './adpcm.js';
import type { AudioFormat } from './config.js';

export const PROTOCOL_VERSION = 1;

/** WebSocket close codes the server uses (4000-4999 is the application range). */
export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  ProtocolError: 4002,
  UnsupportedFormat: 4003,
  Replaced: 4004,
  HelloTimeout: 4005,
  Timeout: 4008,
} as const;

export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_CONTROL_MESSAGE_BYTES = 4096;

export interface HelloMessage {
  type: 'hello';
  device_id: string;
  sample_rate: number;
  bits: number;
  channels: number;
  format: string;
  /** Samples per binary frame; required for block codecs (ima_adpcm). */
  frame_samples?: number;
  /** Optional device-reported details. */
  ip?: string;
  mac?: string;
  firmware?: string;
  rssi?: number;
  reset_reason?: string;
}

export interface TelemetryMessage {
  type: 'telemetry';
  rssi?: number;
  free_heap?: number;
  min_free_heap?: number;
  uptime_s?: number;
  dropped_bytes?: number;
  i2s_errors?: number;
  frames_sent?: number;
  mic_gain_db?: number;
  agc?: boolean;
}

export type ControlMessage =
  | HelloMessage
  | TelemetryMessage
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'ping' };

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly closeCode: number = CloseCode.ProtocolError,
  ) {
    super(message);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const optStr = (v: unknown, max = 64) => (typeof v === 'string' && v.length <= max ? v : undefined);
const optNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function parseControlMessage(raw: Buffer): ControlMessage {
  if (raw.length > MAX_CONTROL_MESSAGE_BYTES) throw new ProtocolError('control message too large');
  let msg: unknown;
  try {
    msg = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ProtocolError('control message is not valid JSON');
  }
  if (!isObj(msg) || typeof msg.type !== 'string') throw new ProtocolError('control message needs a "type"');

  switch (msg.type) {
    case 'hello': {
      if (typeof msg.device_id !== 'string' || !DEVICE_ID_PATTERN.test(msg.device_id)) {
        throw new ProtocolError('device_id must be 1-64 characters of A-Z a-z 0-9 _ -');
      }
      return {
        type: 'hello',
        device_id: msg.device_id,
        sample_rate: Number(msg.sample_rate),
        bits: Number(msg.bits),
        channels: Number(msg.channels),
        format: String(msg.format),
        frame_samples: optNum(msg.frame_samples),
        ip: optStr(msg.ip, 45),
        mac: optStr(msg.mac, 17),
        firmware: optStr(msg.firmware),
        rssi: optNum(msg.rssi),
        reset_reason: optStr(msg.reset_reason),
      };
    }
    case 'telemetry':
      return {
        type: 'telemetry',
        rssi: optNum(msg.rssi),
        free_heap: optNum(msg.free_heap),
        min_free_heap: optNum(msg.min_free_heap),
        uptime_s: optNum(msg.uptime_s),
        dropped_bytes: optNum(msg.dropped_bytes),
        i2s_errors: optNum(msg.i2s_errors),
        frames_sent: optNum(msg.frames_sent),
        mic_gain_db: optNum(msg.mic_gain_db),
        agc: typeof msg.agc === 'boolean' ? msg.agc : undefined,
      };
    case 'start':
    case 'stop':
    case 'ping':
      return { type: msg.type };
    default:
      throw new ProtocolError(`unknown message type "${msg.type}"`);
  }
}

/** Reject any hello whose declared stream format differs from what the server records. */
export function checkHelloFormat(hello: HelloMessage, expected: AudioFormat): void {
  const problems: string[] = [];
  if (hello.sample_rate !== expected.sampleRate) problems.push(`sample_rate ${hello.sample_rate} ≠ ${expected.sampleRate}`);
  if (hello.bits !== expected.bitsPerSample) problems.push(`bits ${hello.bits} ≠ ${expected.bitsPerSample}`);
  if (hello.channels !== expected.channels) problems.push(`channels ${hello.channels} ≠ ${expected.channels}`);
  if (hello.format === ADPCM_FORMAT) {
    const n = hello.frame_samples;
    if (n === undefined || !Number.isInteger(n) || n < 2 || n > 16384 || n % 2 !== 0) {
      problems.push('ima_adpcm needs an even frame_samples between 2 and 16384');
    }
  } else if (hello.format !== expected.format) {
    problems.push(`format ${hello.format} ≠ ${expected.format} or ${ADPCM_FORMAT}`);
  }
  if (problems.length) throw new ProtocolError(`unsupported audio format: ${problems.join(', ')}`, CloseCode.UnsupportedFormat);
}
