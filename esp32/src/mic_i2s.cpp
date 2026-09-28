#include "mic_i2s.h"

#include <driver/i2s_std.h>
#include <math.h>

#include "config.h"

// DMA: 6 × 256 frames ≈ 96 ms of slack before the driver overruns.
static constexpr int DMA_DESC_NUM = 6;
static constexpr int DMA_FRAME_NUM = 256;
static constexpr size_t RAW_SAMPLES = 256;

static i2s_chan_handle_t s_rx = nullptr;
static int32_t s_raw[RAW_SAMPLES];  // static: never allocate in the audio path

// DC blocker state: y[n] = x[n] - x[n-1] + R * y[n-1]
static float s_prevIn = 0.0f;
static float s_prevOut = 0.0f;
static constexpr float DC_R = 0.995f;  // ≈ 12 Hz corner at 16 kHz

bool micBegin() {
  if (s_rx) return true;

  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  chan.dma_desc_num = DMA_DESC_NUM;
  chan.dma_frame_num = DMA_FRAME_NUM;
  if (i2s_new_channel(&chan, nullptr, &s_rx) != ESP_OK) {
    s_rx = nullptr;
    return false;
  }

  i2s_std_config_t std = {};
  std.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(AUDIO_SAMPLE_RATE);
  std.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO);
  std.slot_cfg.slot_mask = MIC_USE_RIGHT_SLOT ? I2S_STD_SLOT_RIGHT : I2S_STD_SLOT_LEFT;
  std.gpio_cfg.mclk = I2S_GPIO_UNUSED;
  std.gpio_cfg.bclk = (gpio_num_t)I2S_BCLK;
  std.gpio_cfg.ws = (gpio_num_t)I2S_LRCLK;
  std.gpio_cfg.dout = I2S_GPIO_UNUSED;
  std.gpio_cfg.din = (gpio_num_t)I2S_DIN;

  if (i2s_channel_init_std_mode(s_rx, &std) != ESP_OK || i2s_channel_enable(s_rx) != ESP_OK) {
    i2s_del_channel(s_rx);
    s_rx = nullptr;
    return false;
  }
  s_prevIn = s_prevOut = 0.0f;
  return true;
}

void micEnd() {
  if (!s_rx) return;
  i2s_channel_disable(s_rx);
  i2s_del_channel(s_rx);
  s_rx = nullptr;
}

// ------------------------------------------------------------------ AGC
//
// Speech-aware automatic gain control, run once per block (256 samples = 16 ms):
//  - learns the room's noise floor (follows quiet moments fast, rises slowly),
//  - raises gain only while the signal is clearly above that floor, and slowly,
//    so silence/hiss is never pumped up,
//  - lowers gain fast (~30 ms) when it gets loud, and never lets a block clip.
// Gain changes are interpolated across the block so they don't click.

static float s_gain = MIC_GAIN;
static float s_noiseFloor = -1.0f;  // pre-gain RMS; <0 = not yet learned
static float s_x[RAW_SAMPLES];

float micGain() { return s_gain; }

#if MIC_AGC
static float agcTarget(float rms, float peak) {
  static const float TARGET_RMS = 32768.0f * powf(10.0f, AGC_TARGET_DBFS / 20.0f);
  static const float PEAK_CEILING = 32000.0f;

  // Noise floor: drop quickly to quiet blocks, creep up slowly (~30 s).
  if (s_noiseFloor < 0.0f) s_noiseFloor = rms;
  else if (rms < s_noiseFloor) s_noiseFloor += (rms - s_noiseFloor) * 0.2f;
  else s_noiseFloor += (rms - s_noiseFloor) * 0.0005f;

  float g = s_gain;
  float want = rms > 1.0f ? TARGET_RMS / rms : AGC_MAX_GAIN;
  if (want > AGC_MAX_GAIN) want = AGC_MAX_GAIN;
  if (want < AGC_MIN_GAIN) want = AGC_MIN_GAIN;

  bool speech = rms > s_noiseFloor * 2.5f;  // ~8 dB above the floor
  if (want < g) {
    g += (want - g) * 0.4f;                  // attack: fast
  } else if (speech) {
    g += (want - g) * 0.004f;                // release: ~4 s, only on real signal
  }                                          // otherwise hold

  if (peak * g > PEAK_CEILING) g = PEAK_CEILING / peak;  // never clip this block
  if (g < AGC_MIN_GAIN) g = AGC_MIN_GAIN;
  return g;
}
#endif

int micRead(int16_t *out, size_t maxSamples, uint32_t timeoutMs) {
  if (!s_rx) return -1;
  size_t want = maxSamples < RAW_SAMPLES ? maxSamples : RAW_SAMPLES;
  size_t bytesRead = 0;
  esp_err_t err = i2s_channel_read(s_rx, s_raw, want * sizeof(int32_t), &bytesRead, timeoutMs);
  if (err == ESP_ERR_TIMEOUT) return 0;
  if (err != ESP_OK) return -1;

  size_t n = bytesRead / sizeof(int32_t);
  if (n == 0) return 0;

  // Pass 1: 24-bit sample in the top bits of the 32-bit slot → 16-bit scale, DC removal, level.
  float sumSq = 0.0f, peak = 0.0f;
  for (size_t i = 0; i < n; i++) {
    float x = (float)(s_raw[i] >> 8) / 256.0f;
#if MIC_DC_BLOCK
    float y = x - s_prevIn + DC_R * s_prevOut;
    s_prevIn = x;
    s_prevOut = y;
    x = y;
#endif
    s_x[i] = x;
    sumSq += x * x;
    float a = fabsf(x);
    if (a > peak) peak = a;
  }

  // Pass 2: apply gain, interpolated from the previous block's gain to the new one.
  float g0 = s_gain;
#if MIC_AGC
  float g1 = agcTarget(sqrtf(sumSq / n), peak);
#else
  float g1 = MIC_GAIN;
#endif
  float step = (g1 - g0) / (float)n;
  for (size_t i = 0; i < n; i++) {
    float v = s_x[i] * (g0 + step * (float)(i + 1));
    if (v > 32767.0f) v = 32767.0f;
    if (v < -32768.0f) v = -32768.0f;
    out[i] = (int16_t)v;
  }
  s_gain = g1;
  return (int)n;
}
