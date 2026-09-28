import { spawn } from 'node:child_process';
import { rename, rm, stat } from 'node:fs/promises';
import type { Logger } from './logger.js';

export interface Mp3Options {
  /** Path or name of the LAME encoder binary. */
  lamePath: string;
  /** Constant bitrate in kbps. 32 is plenty for 16 kHz mono speech. */
  bitrateKbps: number;
}

/** Suffix of the file being written; renamed into place only when complete. */
export const PARTIAL_SUFFIX = '.part';

export function mp3PathFor(wavPath: string): string {
  return wavPath.replace(/\.wav$/, '.mp3');
}

/**
 * Converts finished WAV recordings to MP3, one at a time so a burst of
 * finished recordings can't saturate the CPU. A WAV is deleted only after
 * its MP3 has been fully written and renamed into place, so a crash at any
 * point leaves either the WAV or the MP3 (picked up again at the next start).
 */
export class Mp3Transcoder {
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  /** WAV paths queued or being converted. */
  private readonly inQueue = new Set<string>();
  private stopped = false;
  private current: ReturnType<typeof spawn> | null = null;

  constructor(
    private readonly opts: Mp3Options,
    private readonly log: Logger,
  ) {}

  /** Check the encoder can run. Resolves to its version string, or null. */
  async probe(): Promise<string | null> {
    return new Promise((resolve) => {
      const p = spawn(this.opts.lamePath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      p.stdout.on('data', (d: Buffer) => (out += d.toString()));
      p.on('error', () => resolve(null));
      p.on('close', (code) => resolve(code === 0 ? (out.split('\n')[0] ?? 'lame').trim() : null));
    });
  }

  get queued(): number {
    return this.pending;
  }

  /** Queue a WAV for conversion. Resolves with the MP3 path, or null if it failed. */
  /** True while `wavPath` is waiting for or undergoing conversion. */
  isQueued(wavPath: string): boolean {
    return this.inQueue.has(wavPath);
  }

  enqueue(wavPath: string): Promise<string | null> {
    this.pending++;
    this.inQueue.add(wavPath);
    const job = this.queue.then(() => (this.stopped ? null : this.convert(wavPath)));
    this.queue = job.then(
      () => undefined,
      () => undefined,
    );
    return job.finally(() => {
      this.pending--;
      this.inQueue.delete(wavPath);
    });
  }

  /** Resolves when everything queued so far has been processed. */
  async idle(): Promise<void> {
    await this.queue;
  }

  /** Stop taking new work and abort the running encode (its WAV is kept for next start). */
  stop(): void {
    this.stopped = true;
    this.current?.kill('SIGTERM');
  }

  private async convert(wavPath: string): Promise<string | null> {
    const mp3 = mp3PathFor(wavPath);
    const part = mp3 + PARTIAL_SUFFIX;
    const started = Date.now();
    try {
      const before = (await stat(wavPath)).size;
      await this.runLame(wavPath, part);
      const after = (await stat(part)).size;
      if (after === 0) throw new Error('encoder produced an empty file');
      await rename(part, mp3);
      await rm(wavPath);
      this.log.info(
        `Converted to MP3: ${mp3.split('/').pop()} (${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB, ` +
          `${((1 - after / before) * 100).toFixed(0)}% smaller, ${Date.now() - started} ms)`,
      );
      return mp3;
    } catch (err) {
      await rm(part, { force: true }).catch(() => {});
      if (!this.stopped) this.log.error(`MP3 conversion failed for ${wavPath.split('/').pop()}; WAV kept`, err);
      return null;
    }
  }

  private runLame(input: string, output: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // -S silent, CBR at the configured rate, mono; keeps the 16 kHz sample rate.
      const p = spawn(this.opts.lamePath, ['-S', '--cbr', '-b', String(this.opts.bitrateKbps), '-m', 'm', input, output], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      this.current = p;
      let stderr = '';
      p.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      p.on('error', (err) => reject(err));
      p.on('close', (code, signal) => {
        this.current = null;
        if (code === 0) resolve();
        else reject(new Error(`lame exited with ${signal ?? code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`));
      });
    });
  }
}
