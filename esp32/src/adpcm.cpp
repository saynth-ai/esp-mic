#include "adpcm.h"

static const int16_t kStep[89] = {
    7,     8,     9,     10,    11,    12,    13,    14,    16,    17,    19,    21,    23,    25,    28,
    31,    34,    37,    41,    45,    50,    55,    60,    66,    73,    80,    88,    97,    107,   118,
    130,   143,   157,   173,   190,   209,   230,   253,   279,   307,   337,   371,   408,   449,   494,
    544,   598,   658,   724,   796,   876,   963,   1060,  1166,  1282,  1411,  1552,  1707,  1878,  2066,
    2272,  2499,  2749,  3024,  3327,  3660,  4026,  4428,  4871,  5358,  5894,  6484,  7132,  7845,  8630,
    9493,  10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767};

static const int8_t kIndexAdjust[16] = {-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8};

// Quantise one sample and update the predictor exactly as the decoder will.
static uint8_t encodeSample(int16_t sample, int *pred, int *index) {
  int step = kStep[*index];
  int diff = sample - *pred;
  uint8_t code = 0;
  if (diff < 0) {
    code = 8;
    diff = -diff;
  }
  int vpdiff = step >> 3;
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

  int p = (code & 8) ? *pred - vpdiff : *pred + vpdiff;
  if (p > 32767) p = 32767;
  if (p < -32768) p = -32768;
  *pred = p;

  int i = *index + kIndexAdjust[code];
  if (i < 0) i = 0;
  if (i > 88) i = 88;
  *index = i;
  return code;
}

size_t adpcmEncodeBlock(const int16_t *pcm, size_t n, uint8_t *out, uint8_t *index) {
  int pred = pcm[0];
  int idx = *index > 88 ? 88 : *index;
  out[0] = (uint8_t)(pcm[0] & 0xff);
  out[1] = (uint8_t)((uint16_t)pcm[0] >> 8);
  out[2] = (uint8_t)idx;
  out[3] = 0;

  size_t o = 4;
  bool low = true;
  for (size_t i = 1; i < n; i++) {
    uint8_t code = encodeSample(pcm[i], &pred, &idx);
    if (low) {
      out[o] = code;
    } else {
      out[o++] |= (uint8_t)(code << 4);
    }
    low = !low;
  }
  if (!low) o++;  // odd number of codes: last byte half used
  // Pad to the fixed block size so every block of n samples is the same length.
  while (o < adpcmBlockBytes(n)) out[o++] = 0;
  *index = (uint8_t)idx;
  return o;
}
