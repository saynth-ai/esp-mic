#pragma once
#include <stddef.h>
#include <stdint.h>

// IMA-ADPCM (4 bits/sample, 4:1 vs 16-bit PCM), block format:
//
//   byte 0-1  first sample, int16 little-endian (stored verbatim)
//   byte 2    step index 0..88 at the start of the block
//   byte 3    reserved (0)
//   byte 4..  samples 1..n-1 as 4-bit codes, low nibble first
//
// Every block is decodable on its own, so a dropped block never corrupts
// the following ones. Plain C, no Arduino dependencies (host-testable).

#ifdef __cplusplus
extern "C" {
#endif

// Encoded size of an n-sample block.
static inline size_t adpcmBlockBytes(size_t n) { return 4 + n / 2; }

// Encode n (>= 1) samples. `index` carries the step index from block to block
// for better quality; pass 0 initially. Returns bytes written (adpcmBlockBytes(n)).
size_t adpcmEncodeBlock(const int16_t *pcm, size_t n, uint8_t *out, uint8_t *index);

#ifdef __cplusplus
}
#endif
