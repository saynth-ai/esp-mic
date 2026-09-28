import fs from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { buildWavHeader, bytesPerSecond, WAV_HEADER_BYTES, WAV_MAX_DATA_BYTES, type PcmFormat } from './wav.js';

/** Write to disk once this much audio is buffered, even between timed flushes. */
const WRITE_THRESHOLD_BYTES = 64 * 1024;

/** Paths claimed by recorders in this process that may not exist on disk yet. */
const reserved = new Set<string>();

export interface RecorderOptions {
  dir: string;
  deviceId: string;
  format: PcmFormat;
  /** Buffered audio is written and the header patched + fsynced this often. */
  flushIntervalMs: number;
  startedAt?: Date;
  /** Called once, on the first I/O failure. The recorder stops accepting audio afterwards. */
  onError?: (err: Error) => void;
}

export interface FinishedRecording {
  filename: string;
  path: string;
  startedAt: Date;
  dataBytes: number;
  durationSeconds: number;
  error: Error | null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local-time stamp used in filenames: 2026-09-28_11-30-45 */
export function fileTimestamp(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

function claimPath(dir: string, base: string): string {
  for (let i = 0; i < 1000; i++) {
    const p = path.join(dir, i === 0 ? `${base}.wav` : `${base}_${i}.wav`);
    // The WAV may already have been converted away, so check the MP3 name too.
    if (!reserved.has(p) && !fs.existsSync(p) && !fs.existsSync(p.replace(/\.wav$/, '.mp3'))) {
      reserved.add(p);
      return p;
    }
  }
  throw new Error(`no free filename for ${base}`);
}

/**
 * Streams PCM into a WAV file.
 *
 * The file always holds a valid header: it is written on open and re-written
 * (then fsynced) on every timed flush, so a crash loses at most one flush
 * interval of audio. All file operations run strictly in order on one chain.
 */
export class WavRecorder {
  readonly filename: string;
  readonly path: string;
  readonly startedAt: Date;
  readonly format: PcmFormat;
  error: Error | null = null;

  private fh: FileHandle | null = null;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private accepted = 0;
  private written = 0;
  private headerBytes = -1;
  private writeQueued = false;
  private closed = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly timer: NodeJS.Timeout;
  private readonly onError?: (err: Error) => void;

  constructor(opts: RecorderOptions) {
    this.format = opts.format;
    this.startedAt = opts.startedAt ?? new Date();
    this.onError = opts.onError;
    this.path = claimPath(opts.dir, `${opts.deviceId}_${fileTimestamp(this.startedAt)}`);
    this.filename = path.basename(this.path);

    this.enqueue(async () => {
      // 'wx' = fail rather than ever overwrite an existing recording.
      this.fh = await open(this.path, 'wx');
      await this.writeHeader(true);
    });
    this.timer = setInterval(() => this.enqueue(() => this.persist(true)), opts.flushIntervalMs);
    this.timer.unref();
  }

  /** Audio bytes accepted so far (including ones not yet on disk). */
  get dataBytes(): number {
    return this.accepted;
  }

  get durationSeconds(): number {
    return this.accepted / bytesPerSecond(this.format);
  }

  get isOpen(): boolean {
    return !this.closed && !this.error;
  }

  /** True if `bytes` more would still fit inside the 4 GB WAV limit. */
  canAccept(bytes: number): boolean {
    return this.accepted + bytes <= WAV_MAX_DATA_BYTES;
  }

  write(chunk: Buffer): boolean {
    if (!this.isOpen || !this.canAccept(chunk.length)) return false;
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    this.accepted += chunk.length;
    if (this.pendingBytes >= WRITE_THRESHOLD_BYTES && !this.writeQueued) {
      this.writeQueued = true;
      this.enqueue(() => this.persist(false));
    }
    return true;
  }

  /** Write everything buffered, patch the header and fsync. */
  flush(): Promise<void> {
    return this.enqueue(() => this.persist(true));
  }

  async finalize(): Promise<FinishedRecording> {
    if (!this.closed) {
      this.closed = true;
      clearInterval(this.timer);
      this.enqueue(() => this.persist(true));
      await this.chain;
      try {
        await this.fh?.close();
      } catch (err) {
        this.fail(err);
      }
      this.fh = null;
      reserved.delete(this.path);
    } else {
      await this.chain;
    }
    return {
      filename: this.filename,
      path: this.path,
      startedAt: this.startedAt,
      dataBytes: this.written,
      durationSeconds: this.written / bytesPerSecond(this.format),
      error: this.error,
    };
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    this.chain = this.chain
      .then(() => (this.error ? undefined : op()))
      .catch((err: unknown) => this.fail(err));
    return this.chain;
  }

  private fail(err: unknown): void {
    if (this.error) return;
    this.error = err instanceof Error ? err : new Error(String(err));
    clearInterval(this.timer);
    this.pending = [];
    this.pendingBytes = 0;
    this.onError?.(this.error);
  }

  private async persist(sync: boolean): Promise<void> {
    this.writeQueued = false;
    const fh = this.fh;
    if (!fh) return;
    if (this.pendingBytes > 0) {
      const buf = this.pending.length === 1 ? this.pending[0]! : Buffer.concat(this.pending, this.pendingBytes);
      this.pending = [];
      this.pendingBytes = 0;
      // Explicit positions: never rely on append mode, the header is rewritten in place.
      let off = 0;
      while (off < buf.length) {
        const { bytesWritten } = await fh.write(buf, off, buf.length - off, WAV_HEADER_BYTES + this.written + off);
        off += bytesWritten;
      }
      this.written += buf.length;
    }
    if (sync) await this.writeHeader(true);
  }

  private async writeHeader(sync: boolean): Promise<void> {
    const fh = this.fh;
    if (!fh || this.headerBytes === this.written) return;
    await fh.write(buildWavHeader(this.format, this.written), 0, WAV_HEADER_BYTES, 0);
    this.headerBytes = this.written;
    if (sync) await fh.datasync();
  }
}
