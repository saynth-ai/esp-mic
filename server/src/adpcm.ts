/**
 * IMA-ADPCM block codec, bit-compatible with the ESP32 firmware (esp32/src/adpcm.cpp).
 *
 * Block of n samples:
 *   0-1   first sample, int16 LE (verbatim)
 *   2     step index 0..88
 *   3     reserved
 *   4..   samples 1..n-1 as 4-bit codes, low nibble first; padded to 4 + floor(n/2) bytes
 *
 * Each block decodes on its own, so a lost block never corrupts later ones.
 */

const STEP = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
  118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
  6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];
const INDEX_ADJUST = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

export const ADPCM_FORMAT = 'ima_adpcm';

export function adpcmBlockBytes(samples: number): number {
  return 4 + Math.floor(samples / 2);
}

const clamp16 = (v: number) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);
const clampIndex = (i: number) => (i < 0 ? 0 : i > 88 ? 88 : i);

/** Decode one block to 16-bit LE PCM. Returns null if the block is malformed. */
export function decodeAdpcmBlock(block: Buffer, samples: number): Buffer | null {
  if (block.length !== adpcmBlockBytes(samples) || block[2]! > 88) return null;
  const out = Buffer.allocUnsafe(samples * 2);
  let pred = block.readInt16LE(0);
  let index = block[2]!;
  out.writeInt16LE(pred, 0);
  for (let i = 1; i < samples; i++) {
    const byte = block[4 + ((i - 1) >> 1)]!;
    const code = (i - 1) & 1 ? byte >> 4 : byte & 0x0f;
    const step = STEP[index]!;
    let diff = step >> 3;
    if (code & 4) diff += step;
    if (code & 2) diff += step >> 1;
    if (code & 1) diff += step >> 2;
    pred = clamp16(code & 8 ? pred - diff : pred + diff);
    index = clampIndex(index + INDEX_ADJUST[code]!);
    out.writeInt16LE(pred, i * 2);
  }
  return out;
}

/** Encoder mirroring the firmware (used by tests and the device simulator). */
export class AdpcmEncoder {
  private index = 0;

  encode(pcm: Int16Array): Buffer {
    const n = pcm.length;
    const out = Buffer.alloc(adpcmBlockBytes(n));
    let pred = pcm[0]!;
    let index = this.index;
    out.writeInt16LE(pred, 0);
    out[2] = index;
    let o = 4;
    let low = true;
    for (let i = 1; i < n; i++) {
      let step = STEP[index]!;
      let diff = pcm[i]! - pred;
      let code = 0;
      if (diff < 0) {
        code = 8;
        diff = -diff;
      }
      let vpdiff = step >> 3;
      if (diff >= step) {
        code |= 4;
        diff -= step;
        vpdiff += step;
      }
      step >>= 1;
      if (diff >= step) {
        code |= 2;
        diff -= step;
        vpdiff += step;
      }
      step >>= 1;
      if (diff >= step) {
        code |= 1;
        vpdiff += step;
      }
      pred = clamp16(code & 8 ? pred - vpdiff : pred + vpdiff);
      index = clampIndex(index + INDEX_ADJUST[code]!);
      if (low) {
        out[o] = code;
      } else {
        out[o] = out[o]! | (code << 4);
        o++;
      }
      low = !low;
    }
    this.index = index;
    return out;
  }
}
