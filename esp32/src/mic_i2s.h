#pragma once
#include <stddef.h>
#include <stdint.h>

// INMP441 capture over I2S (ESP-IDF 5 "std" driver, Arduino-ESP32 3.x).
//
// The mic delivers 24-bit samples left-aligned in 32-bit slots. micRead()
// returns them as 16 kHz mono signed 16-bit PCM after DC removal and gain.

bool micBegin();
void micEnd();

// Blocks up to timeoutMs. Returns samples written to `out` (≤ maxSamples),
// 0 on timeout, or -1 on a driver error.
int micRead(int16_t *out, size_t maxSamples, uint32_t timeoutMs);

// Current linear gain (fixed MIC_GAIN, or the AGC's live value when MIC_AGC=1).
float micGain();
