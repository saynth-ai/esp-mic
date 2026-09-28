/**
 * Minimal RIFF/WAVE (PCM) header support.
 *
 * We always write the canonical 44-byte header; the parser is tolerant of
 * extra chunks so it can read files produced by other tools too.
 */

export interface PcmFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export const WAV_HEADER_BYTES = 44;

/** RIFF sizes are 32-bit, so a WAV file cannot hold more than this many data bytes. */
export const WAV_MAX_DATA_BYTES = 0xffffffff - (WAV_HEADER_BYTES - 8);

export function bytesPerSecond(fmt: PcmFormat): number {
  return fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
}

export function blockAlign(fmt: PcmFormat): number {
  return fmt.channels * (fmt.bitsPerSample / 8);
}

export function buildWavHeader(fmt: PcmFormat, dataBytes: number): Buffer {
  const h = Buffer.alloc(WAV_HEADER_BYTES);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // audio format 1 = integer PCM
  h.writeUInt16LE(fmt.channels, 22);
  h.writeUInt32LE(fmt.sampleRate, 24);
  h.writeUInt32LE(bytesPerSecond(fmt), 28);
  h.writeUInt16LE(blockAlign(fmt), 32);
  h.writeUInt16LE(fmt.bitsPerSample, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export interface WavInfo extends PcmFormat {
  audioFormat: number;
  /** Declared RIFF chunk size (file length - 8 when consistent). */
  riffSize: number;
  /** Byte offset of the first sample. */
  dataOffset: number;
  /** Declared size of the data chunk. */
  dataBytes: number;
}

/** Parse the header from the first bytes of a file. Returns null if it isn't a PCM-style WAV. */
export function parseWavHeader(buf: Buffer): WavInfo | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  const riffSize = buf.readUInt32LE(4);
  let fmt: Omit<WavInfo, 'riffSize' | 'dataOffset' | 'dataBytes'> | null = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) return null;
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) return null;
      return { ...fmt, riffSize, dataOffset: body, dataBytes: size };
    }
    off = body + size + (size & 1); // chunks are word aligned
  }
  return null;
}
