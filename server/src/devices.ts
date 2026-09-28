import { EventEmitter } from 'node:events';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { HelloMessage, TelemetryMessage } from './protocol.js';
import { WavRecorder, type FinishedRecording } from './recorder.js';
import type { RecordingStore } from './recordings.js';
import { bytesPerSecond, WAV_HEADER_BYTES, type PcmFormat } from './wav.js';

/** How a device session talks back to its socket; keeps this module transport-agnostic. */
export interface DeviceConnection {
  send(msg: object): void;
  close(code: number, reason: string): void;
}

/** Everything the dashboard and REST API know about one device. */
export interface DeviceStatus {
  type: 'status';
  device_id: string;
  /** WebSocket to the device is open and the hello was accepted. */
  connected: boolean;
  /** Audio has arrived within AUDIO_TIMEOUT_MS. */
  streaming: boolean;
  /** A WAV file is open for this device. */
  recording: boolean;
  /** 'connected' while the device is online; unknowable once it is offline. */
  wifi: 'connected' | 'unknown';
  wifi_rssi: number | null;
  ip: string | null;
  remote_address: string | null;
  mac: string | null;
  firmware: string | null;
  reset_reason: string | null;
  connected_since: string | null;
  disconnected_at: string | null;
  disconnect_reason: string | null;
  sample_rate: number;
  bits: number;
  channels: number;
  format: string;
  current_recording: string | null;
  recording_started_at: string | null;
  /** Seconds of audio in the current recording. */
  recording_duration: number;
  /** Size of the current recording file, header included. */
  recording_bytes: number;
  /** Counters for the current connection. */
  packets_received: number;
  bytes_received: number;
  invalid_frames: number;
  last_packet: string | null;
  /** Set when the incoming byte rate doesn't match the declared format. */
  rate_warning: string | null;
  recording_error: string | null;
  /** Latest device telemetry. */
  free_heap: number | null;
  min_free_heap: number | null;
  uptime_s: number | null;
  dropped_bytes: number | null;
  i2s_errors: number | null;
  /** Microphone gain in dB, and whether it is set by the device's AGC. */
  mic_gain_db: number | null;
  agc: boolean | null;
}

interface DeviceState {
  status: DeviceStatus;
  session: DeviceSession | null;
  recorder: WavRecorder | null;
  lastPacketMs: number;
  recorderRetryAt: number;
  rateWindowStart: number;
  rateWindowBytes: number;
  dirty: boolean;
  lastEmitMs: number;
}

export interface DeviceManagerEvents {
  status: [DeviceStatus];
  /** The set of recordings (or one of their active flags) changed. */
  recordings: [];
  /** Every accepted PCM frame — the hook for future sinks (VAD, STT, live monitor…). */
  audio: [deviceId: string, pcm: Buffer];
  recordingSaved: [deviceId: string, recording: FinishedRecording];
}

const RATE_WINDOW_MS = 10_000;
const RATE_TOLERANCE = 1.5;
const RECORDER_RETRY_MS = 10_000;

/**
 * Handle for one accepted device connection. Every method is a no-op once the
 * session has been superseded (device reconnected) or closed, so a late event
 * from an old socket can never touch the new session's recording.
 */
export class DeviceSession {
  constructor(
    private readonly mgr: DeviceManager,
    readonly deviceId: string,
    readonly conn: DeviceConnection,
  ) {}

  get current(): boolean {
    return this.mgr.isCurrent(this);
  }
  start(): void {
    this.mgr.handleStart(this);
  }
  audio(pcm: Buffer): void {
    this.mgr.handleAudio(this, pcm);
  }
  stop(): void {
    this.mgr.handleStop(this);
  }
  telemetry(t: TelemetryMessage): void {
    this.mgr.handleTelemetry(this, t);
  }
  closed(reason: string): void {
    this.mgr.handleClosed(this, reason);
  }
}

export class DeviceManager extends EventEmitter<DeviceManagerEvents> {
  private readonly devices = new Map<string, DeviceState>();
  private readonly finalizing = new Set<Promise<unknown>>();
  private readonly timer: NodeJS.Timeout;
  private readonly format: PcmFormat;
  private readonly bps: number;

  constructor(
    private readonly config: Config,
    private readonly store: RecordingStore,
    private readonly log: Logger,
  ) {
    super();
    this.format = {
      sampleRate: config.audio.sampleRate,
      channels: config.audio.channels,
      bitsPerSample: config.audio.bitsPerSample,
    };
    this.bps = bytesPerSecond(this.format);
    const tick = Math.max(20, Math.min(250, config.statusIntervalMs, Math.floor(config.audioTimeoutMs / 4)));
    this.timer = setInterval(() => this.tick(), tick);
    this.timer.unref();
  }

  list(): DeviceStatus[] {
    return [...this.devices.values()]
      .map((d) => this.snapshot(d))
      .sort((a, b) => Number(b.connected) - Number(a.connected) || a.device_id.localeCompare(b.device_id));
  }

  get(deviceId: string): DeviceStatus | null {
    const d = this.devices.get(deviceId);
    return d ? this.snapshot(d) : null;
  }

  connectedCount(): number {
    let n = 0;
    for (const d of this.devices.values()) if (d.session) n++;
    return n;
  }

  isCurrent(session: DeviceSession): boolean {
    return this.devices.get(session.deviceId)?.session === session;
  }

  /** Register a device after a valid hello. An older connection for the same id is closed. */
  connect(hello: HelloMessage, conn: DeviceConnection, remoteAddress: string | null): DeviceSession {
    let state = this.devices.get(hello.device_id);
    if (state?.session) {
      this.log.warn(`Device ${hello.device_id} reconnected; closing its previous connection`);
      state.session.conn.close(4004, 'replaced by a newer connection');
      this.endSession(state, 'replaced by a newer connection');
    }
    if (!state) {
      state = {
        status: this.blankStatus(hello.device_id),
        session: null,
        recorder: null,
        lastPacketMs: 0,
        recorderRetryAt: 0,
        rateWindowStart: 0,
        rateWindowBytes: 0,
        dirty: false,
        lastEmitMs: 0,
      };
      this.devices.set(hello.device_id, state);
    }

    const session = new DeviceSession(this, hello.device_id, conn);
    state.session = session;
    state.recorderRetryAt = 0;
    state.rateWindowStart = 0;
    state.rateWindowBytes = 0;
    Object.assign(state.status, {
      connected: true,
      streaming: false,
      recording: false,
      wifi: 'connected',
      wifi_rssi: hello.rssi ?? null,
      ip: hello.ip ?? remoteAddress,
      remote_address: remoteAddress,
      mac: hello.mac ?? null,
      firmware: hello.firmware ?? null,
      reset_reason: hello.reset_reason ?? null,
      connected_since: new Date().toISOString(),
      disconnected_at: null,
      disconnect_reason: null,
      packets_received: 0,
      bytes_received: 0,
      invalid_frames: 0,
      rate_warning: null,
      recording_error: null,
    } satisfies Partial<DeviceStatus>);

    this.log.info(
      `ESP32 connected: ${hello.device_id} ip=${state.status.ip ?? '?'} fw=${hello.firmware ?? '?'}` +
        (hello.reset_reason ? ` reset=${hello.reset_reason}` : ''),
    );
    this.emitNow(state);
    return session;
  }

  handleStart(session: DeviceSession): void {
    if (!this.isCurrent(session)) return;
    this.log.debug(`${session.deviceId}: start requested`);
  }

  handleAudio(session: DeviceSession, pcm: Buffer): void {
    const state = this.devices.get(session.deviceId);
    if (!state || state.session !== session) return;
    const s = state.status;
    const now = Date.now();

    // Samples are 2 bytes; an odd or empty frame would misalign every later sample.
    if (pcm.length === 0 || pcm.length % 2 !== 0) {
      s.invalid_frames++;
      if (s.invalid_frames === 1 || s.invalid_frames % 100 === 0) {
        this.log.warn(`${s.device_id}: dropped invalid audio frame of ${pcm.length} bytes (${s.invalid_frames} so far)`);
      }
      state.dirty = true;
      return;
    }

    s.packets_received++;
    s.bytes_received += pcm.length;
    s.last_packet = new Date(now).toISOString();
    state.lastPacketMs = now;
    this.checkRate(state, pcm.length, now);

    if (!s.streaming) {
      s.streaming = true;
      this.log.info(`${s.device_id}: audio stream started`);
      state.lastEmitMs = 0; // push this transition immediately
    }

    let rec = state.recorder;
    const maxBytes = this.config.maxRecordingSeconds > 0 ? this.config.maxRecordingSeconds * this.bps : Infinity;
    if (rec && (rec.dataBytes + pcm.length > maxBytes || !rec.canAccept(pcm.length))) {
      this.finalizeRecording(state, 'maximum length reached, continuing in a new file');
      rec = null;
    }
    if (!rec && now >= state.recorderRetryAt) rec = this.startRecording(state);
    rec?.write(pcm);
    if (rec) {
      s.recording_duration = Math.floor(rec.durationSeconds);
      s.recording_bytes = WAV_HEADER_BYTES + rec.dataBytes;
    }

    state.dirty = true;
    if (this.listenerCount('audio') > 0) this.emit('audio', s.device_id, pcm);
  }

  handleStop(session: DeviceSession): void {
    const state = this.devices.get(session.deviceId);
    if (!state || state.session !== session) return;
    if (state.status.streaming || state.recorder) this.log.info(`${session.deviceId}: audio stream stopped by device`);
    state.status.streaming = false;
    this.finalizeRecording(state, 'device sent stop');
    this.emitNow(state);
  }

  handleTelemetry(session: DeviceSession, t: TelemetryMessage): void {
    const state = this.devices.get(session.deviceId);
    if (!state || state.session !== session) return;
    const s = state.status;
    if (t.rssi !== undefined) s.wifi_rssi = t.rssi;
    if (t.free_heap !== undefined) s.free_heap = t.free_heap;
    if (t.min_free_heap !== undefined) s.min_free_heap = t.min_free_heap;
    if (t.uptime_s !== undefined) s.uptime_s = t.uptime_s;
    if (t.dropped_bytes !== undefined) s.dropped_bytes = t.dropped_bytes;
    if (t.i2s_errors !== undefined) s.i2s_errors = t.i2s_errors;
    if (t.mic_gain_db !== undefined) s.mic_gain_db = t.mic_gain_db;
    if (t.agc !== undefined) s.agc = t.agc;
    state.dirty = true;
  }

  handleClosed(session: DeviceSession, reason: string): void {
    const state = this.devices.get(session.deviceId);
    if (!state || state.session !== session) return;
    const s = state.status;
    this.log.info(
      `ESP32 disconnected: ${s.device_id} (${reason}) — ${s.packets_received} packets, ${formatBytes(s.bytes_received)} this connection`,
    );
    this.endSession(state, reason);
  }

  /** Close every device connection and finalize every open WAV file. */
  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    for (const state of this.devices.values()) {
      if (state.session) {
        state.session.conn.close(1001, 'server shutting down');
        this.endSession(state, 'server shutting down');
      }
    }
    await this.idle();
  }

  /** Resolves when no recordings are being finalized. */
  async idle(): Promise<void> {
    while (this.finalizing.size) await Promise.allSettled([...this.finalizing]);
  }

  private endSession(state: DeviceState, reason: string): void {
    state.session = null;
    Object.assign(state.status, {
      connected: false,
      streaming: false,
      wifi: 'unknown',
      disconnected_at: new Date().toISOString(),
      disconnect_reason: reason,
    } satisfies Partial<DeviceStatus>);
    this.finalizeRecording(state, reason);
    this.emitNow(state);
  }

  private startRecording(state: DeviceState): WavRecorder | null {
    const id = state.status.device_id;
    let rec: WavRecorder;
    try {
      rec = new WavRecorder({
        dir: this.store.dir,
        deviceId: id,
        format: this.format,
        flushIntervalMs: this.config.flushIntervalMs,
        onError: (err) => {
          this.log.error(`WAV write error (${rec.filename})`, err);
          state.status.recording_error = err.message;
          state.recorderRetryAt = Date.now() + RECORDER_RETRY_MS;
          if (state.recorder === rec) this.finalizeRecording(state, 'write error');
        },
      });
    } catch (err) {
      this.log.error(`WAV write error (${id}): could not create recording`, err);
      state.status.recording_error = err instanceof Error ? err.message : String(err);
      state.recorderRetryAt = Date.now() + RECORDER_RETRY_MS;
      return null;
    }
    state.recorder = rec;
    this.store.setActive(rec.filename, true);
    Object.assign(state.status, {
      recording: true,
      current_recording: rec.filename,
      recording_started_at: rec.startedAt.toISOString(),
      recording_duration: 0,
      recording_bytes: WAV_HEADER_BYTES,
      recording_error: null,
    } satisfies Partial<DeviceStatus>);
    this.log.info(`Recording started: ${rec.filename}`);
    state.lastEmitMs = 0;
    this.emit('recordings');
    return rec;
  }

  private finalizeRecording(state: DeviceState, reason: string): void {
    const rec = state.recorder;
    if (!rec) return;
    state.recorder = null;
    Object.assign(state.status, {
      recording: false,
      current_recording: null,
      recording_started_at: null,
      recording_duration: 0,
      recording_bytes: 0,
    } satisfies Partial<DeviceStatus>);
    state.lastEmitMs = 0;

    const p = rec.finalize().then((done) => {
      this.store.setActive(done.filename, false);
      if (done.error) {
        this.log.error(`WAV write error: ${done.filename} closed after an error; ${formatDuration(done.durationSeconds)} kept`);
      } else {
        this.log.info(
          `Recording saved: ${done.filename} (${formatDuration(done.durationSeconds)}, ${formatBytes(done.dataBytes + WAV_HEADER_BYTES)}) — ${reason}`,
        );
      }
      this.emit('recordingSaved', state.status.device_id, done);
      this.emit('recordings');
    });
    this.finalizing.add(p);
    void p.finally(() => this.finalizing.delete(p));
  }

  private checkRate(state: DeviceState, bytes: number, now: number): void {
    if (state.rateWindowStart === 0) {
      state.rateWindowStart = now;
      state.rateWindowBytes = 0;
      return; // the first frame only marks the start of the window
    }
    state.rateWindowBytes += bytes;
    const elapsed = now - state.rateWindowStart;
    if (elapsed < RATE_WINDOW_MS) return;
    const rate = (state.rateWindowBytes * 1000) / elapsed;
    state.rateWindowStart = now;
    state.rateWindowBytes = 0;
    if (rate > this.bps * RATE_TOLERANCE) {
      const msg = `receiving ${Math.round(rate)} B/s but ${this.config.audio.format} mono ${this.config.audio.sampleRate} Hz is ${this.bps} B/s — check the device's sample rate/format`;
      if (state.status.rate_warning === null) this.log.warn(`${state.status.device_id}: ${msg}`);
      state.status.rate_warning = msg;
    } else {
      state.status.rate_warning = null;
    }
  }

  private tick(): void {
    const now = Date.now();
    for (const state of this.devices.values()) {
      const s = state.status;
      if (s.streaming && now - state.lastPacketMs > this.config.audioTimeoutMs) {
        s.streaming = false;
        state.rateWindowStart = 0;
        this.log.info(
          `${s.device_id}: audio stream stopped — no audio for ${this.config.audioTimeoutMs} ms (WebSocket ${s.connected ? 'still connected' : 'closed'})`,
        );
        this.finalizeRecording(state, 'audio timeout');
        state.lastEmitMs = 0;
        state.dirty = true;
      }
      if (state.dirty && now - state.lastEmitMs >= this.config.statusIntervalMs) this.emitNow(state);
    }
  }

  private emitNow(state: DeviceState): void {
    state.dirty = false;
    state.lastEmitMs = Date.now();
    this.emit('status', this.snapshot(state));
  }

  private snapshot(state: DeviceState): DeviceStatus {
    return { ...state.status };
  }

  private blankStatus(deviceId: string): DeviceStatus {
    return {
      type: 'status',
      device_id: deviceId,
      connected: false,
      streaming: false,
      recording: false,
      wifi: 'unknown',
      wifi_rssi: null,
      ip: null,
      remote_address: null,
      mac: null,
      firmware: null,
      reset_reason: null,
      connected_since: null,
      disconnected_at: null,
      disconnect_reason: null,
      sample_rate: this.config.audio.sampleRate,
      bits: this.config.audio.bitsPerSample,
      channels: this.config.audio.channels,
      format: this.config.audio.format,
      current_recording: null,
      recording_started_at: null,
      recording_duration: 0,
      recording_bytes: 0,
      packets_received: 0,
      bytes_received: 0,
      invalid_frames: 0,
      last_packet: null,
      rate_warning: null,
      recording_error: null,
      free_heap: null,
      min_free_heap: null,
      uptime_s: null,
      dropped_bytes: null,
      i2s_errors: null,
      mic_gain_db: null,
      agc: null,
    };
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDuration(seconds: number): string {
  const t = Math.round(seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}`;
}
