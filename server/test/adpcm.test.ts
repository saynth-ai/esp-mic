import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { adpcmBlockBytes, AdpcmEncoder, decodeAdpcmBlock } from '../src/adpcm.js';
import { FakeDevice, readWav, removeDir, startServer, waitFor, type TestServer } from './helpers.js';

const N = 1024;
const FIRMWARE_ADPCM = path.resolve(import.meta.dirname, '../../esp32/src/adpcm.cpp');

/** Deterministic test signal mixing tones, noise, silence, clipping and square edges. */
function testSignal(blocks: number): Int16Array[] {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  return Array.from({ length: blocks }, (_, b) => {
    const s = new Int16Array(N);
    for (let i = 0; i < N; i++) {
      const t = b * N + i;
      let v = 0;
      if (b % 4 === 0) v = 9000 * Math.sin((t * 2 * Math.PI * 440) / 16000) + 3000 * Math.sin((t * 2 * Math.PI * 2200) / 16000);
      else if (b % 4 === 1) v = 6000 * rnd();
      else if (b % 4 === 2) v = (Math.floor(t / 40) % 2 ? 1 : -1) * 32767; // full-scale square
      else v = 0; // silence
      s[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
    }
    return s;
  });
}

function snrDb(ref: Int16Array, got: Buffer): number {
  let sig = 0;
  let err = 0;
  for (let i = 0; i < ref.length; i++) {
    const r = ref[i]!;
    const g = got.readInt16LE(i * 2);
    sig += r * r;
    err += (r - g) * (r - g);
  }
  return 10 * Math.log10(sig / Math.max(err, 1));
}

describe('IMA-ADPCM codec', () => {
  it('compresses 4:1 and decodes speech-like audio with good fidelity', () => {
    const enc = new AdpcmEncoder();
    const tone = testSignal(1)[0]!;
    const block = enc.encode(tone);
    assert.equal(block.length, adpcmBlockBytes(N));
    assert.equal(block.length, 516, '2048 B of PCM → 516 B');
    const pcm = decodeAdpcmBlock(block, N)!;
    assert.equal(pcm.length, N * 2);
    assert.equal(pcm.readInt16LE(0), tone[0], 'first sample is stored verbatim');
    const snr = snrDb(tone, pcm);
    assert.ok(snr > 20, `SNR ${snr.toFixed(1)} dB`);
  });

  it('decodes a block correctly even when the blocks before it were lost', () => {
    const enc = new AdpcmEncoder();
    const signal = testSignal(5);
    const blocks = signal.map((b) => enc.encode(b));
    // Blocks 1-3 never arrive; block 4 (a tone) must still decode cleanly on its own.
    const snr = snrDb(signal[4]!, decodeAdpcmBlock(blocks[4]!, N)!);
    assert.ok(snr > 20, `SNR after lost blocks ${snr.toFixed(1)} dB`);
  });

  it('rejects malformed blocks', () => {
    assert.equal(decodeAdpcmBlock(Buffer.alloc(515), N), null, 'wrong length');
    const bad = Buffer.alloc(516);
    bad[2] = 89;
    assert.equal(decodeAdpcmBlock(bad, N), null, 'step index out of range');
  });

  it('is bit-identical to the ESP32 firmware encoder (esp32/src/adpcm.cpp)', async (t) => {
    try {
      execFileSync('g++', ['--version'], { stdio: 'ignore' });
    } catch {
      return t.skip('g++ not installed');
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), 'adpcm-'));
    try {
      const harness = path.join(dir, 'harness.cpp');
      await writeFile(
        harness,
        `#include <cstdio>
#include <cstdint>
#include "${FIRMWARE_ADPCM}"
int main() {
  int16_t pcm[${N}]; uint8_t out[${adpcmBlockBytes(N)}]; uint8_t index = 0;
  while (fread(pcm, 2, ${N}, stdin) == ${N}) {
    size_t n = adpcmEncodeBlock(pcm, ${N}, out, &index);
    fwrite(out, 1, n, stdout);
  }
  return 0;
}
`,
      );
      const bin = path.join(dir, 'harness');
      execFileSync('g++', ['-O2', '-std=c++17', '-o', bin, harness]);
      const signal = testSignal(24);
      const input = Buffer.concat(signal.map((s) => Buffer.from(s.buffer)));
      const firmware = execFileSync(bin, { input });
      const enc = new AdpcmEncoder();
      const server = Buffer.concat(signal.map((s) => enc.encode(s)));
      assert.equal(firmware.length, 24 * 516);
      assert.ok(firmware.equals(server), 'firmware and server encoders produce identical bytes');
    } finally {
      await removeDir(dir);
    }
  });
});

describe('ADPCM devices end to end', () => {
  let srv: TestServer;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.stop();
    await removeDir(srv.dir);
  });

  it('decodes ADPCM frames into the PCM recording and counts wire bytes', async () => {
    const dev = new FakeDevice(srv.ws, 'adpcm-dev');
    await dev.connect({ format: 'ima_adpcm', frame_samples: N });
    const enc = new AdpcmEncoder();
    const blocks = testSignal(8).map((s) => enc.encode(s));
    for (const b of blocks) dev.audio(b);
    await waitFor(() => srv.mic.devices.get('adpcm-dev')!.packets_received === 8, 'blocks counted');
    const st = srv.mic.devices.get('adpcm-dev')!;
    assert.equal(st.bytes_received, 8 * 516, 'bytes_received counts compressed wire bytes');
    assert.equal(st.format, 'ima_adpcm');

    dev.ws.send(Buffer.alloc(100), { binary: true }); // malformed block
    await waitFor(() => srv.mic.devices.get('adpcm-dev')!.invalid_frames === 1, 'invalid block counted');

    dev.kill();
    await waitFor(() => !srv.mic.devices.get('adpcm-dev')!.connected, 'disconnect');
    await srv.mic.devices.idle();
    const file = (await readdir(srv.dir)).find((f) => f.startsWith('adpcm-dev_'))!;
    const wav = await readWav(path.join(srv.dir, file));
    const expected = Buffer.concat(blocks.map((b) => decodeAdpcmBlock(b, N)!));
    assert.equal(wav.info.bitsPerSample, 16);
    assert.ok(wav.data.equals(expected), 'recording holds the decoded PCM');
  });

  it('rejects an ADPCM hello without a usable frame_samples', async () => {
    for (const frame_samples of [undefined, 3, 0]) {
      const dev = new FakeDevice(srv.ws, 'adpcm-bad');
      await dev.open();
      dev.send({ type: 'hello', device_id: 'adpcm-bad', sample_rate: 16000, bits: 16, channels: 1, format: 'ima_adpcm', frame_samples });
      assert.equal(await dev.closed(), 4003, `frame_samples=${frame_samples}`);
    }
  });
});
