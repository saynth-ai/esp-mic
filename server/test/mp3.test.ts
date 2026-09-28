import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WavRecorder } from '../src/recorder.js';
import { parseMp3Start } from '../src/recordings.js';
import { buildWavHeader } from '../src/wav.js';
import { FakeDevice, pcmFrame, removeDir, startServer, waitFor, type TestServer } from './helpers.js';

const haveLame = (() => {
  try {
    execFileSync('lame', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Decode an MP3 with LAME and return its duration in seconds. */
function decodedSeconds(mp3: string): number {
  const wav = mp3 + '.check.wav';
  execFileSync('lame', ['--quiet', '--decode', mp3, wav]);
  const size = execFileSync('stat', ['-c', '%s', wav]).toString().trim();
  execFileSync('rm', ['-f', wav]);
  return (Number(size) - 44) / 32000;
}

/** A tone so the encoder has real content to work with. */
function toneFrame(i: number): Buffer {
  const b = Buffer.alloc(2048);
  for (let s = 0; s < 1024; s++) b.writeInt16LE(Math.round(Math.sin(((i * 1024 + s) * 2 * Math.PI * 440) / 16000) * 8000), s * 2);
  return b;
}

describe('MP3 storage', { skip: !haveLame && 'lame not installed' }, () => {
  let srv: TestServer;
  before(async () => {
    srv = await startServer({ RECORDING_FORMAT: 'mp3', MP3_BITRATE: '32' });
  });
  after(async () => {
    await srv.stop();
    await removeDir(srv.dir);
  });

  it('records WAV live, then replaces it with an MP3 once finished', async () => {
    const dev = new FakeDevice(srv.ws, 'mp3-dev');
    await dev.connect();
    for (let i = 0; i < 80; i++) dev.audio(toneFrame(i)); // 80 × 64 ms = 5.12 s
    await waitFor(() => srv.mic.devices.get('mp3-dev')!.packets_received === 80, 'frames');
    const live = srv.mic.devices.get('mp3-dev')!.current_recording!;
    assert.match(live, /\.wav$/, 'the file being recorded is a WAV');

    dev.kill();
    const mp3 = live.replace(/\.wav$/, '.mp3');
    await waitFor(async () => (await readdir(srv.dir)).includes(mp3), 'mp3 file', 10_000);
    const files = await readdir(srv.dir);
    assert.ok(!files.includes(live), 'WAV deleted after conversion');
    assert.ok(!files.some((f) => f.endsWith('.part')), 'no partial files left');

    const wavBytes = 44 + 80 * 2048;
    const mp3Bytes = (await stat(path.join(srv.dir, mp3))).size;
    assert.ok(mp3Bytes < wavBytes / 6, `MP3 ${mp3Bytes} B should be far smaller than WAV ${wavBytes} B`);
    assert.ok(Math.abs(decodedSeconds(path.join(srv.dir, mp3)) - 5.12) < 0.2, 'decodes to the same duration');
    assert.ok(srv.logs.some((l) => l.includes(`Converted to MP3: ${mp3}`)));

    const list = await (await fetch(`${srv.http}/recordings`)).json();
    const rec = list.recordings.find((r: any) => r.filename === mp3);
    assert.equal(rec.device_id, 'mp3-dev');
    assert.ok(Math.abs(rec.duration_seconds - 5.1) <= 0.2, `listed duration ${rec.duration_seconds}`);

    const res = await fetch(`${srv.http}/recordings/${mp3}`, { headers: { Range: 'bytes=0-99' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    await res.arrayBuffer();
    const health = await (await fetch(`${srv.http}/api/health`)).json();
    assert.equal(health.conversions_pending, 0);
  });

  it('converts WAVs left over from a crash at the next start, and cleans partial MP3s', async () => {
    await srv.stop();
    const leftover = 'crashed-dev_2026-09-28_10-00-00.wav';
    const pcm = Buffer.concat(Array.from({ length: 30 }, (_, i) => toneFrame(i)));
    await writeFile(path.join(srv.dir, leftover), Buffer.concat([buildWavHeader({ sampleRate: 16000, channels: 1, bitsPerSample: 16 }, pcm.length), pcm]));
    await writeFile(path.join(srv.dir, 'crashed-dev_2026-09-28_10-00-00.mp3.part'), 'half written');

    srv = await startServer({ RECORDING_FORMAT: 'mp3' }, srv.dir);
    const mp3 = leftover.replace('.wav', '.mp3');
    await waitFor(async () => (await readdir(srv.dir)).includes(mp3), 'leftover converted', 10_000);
    const files = await readdir(srv.dir);
    assert.ok(!files.includes(leftover));
    assert.ok(!files.some((f) => f.endsWith('.part')));
  });

  it('never reuses a name whose WAV was already converted to MP3', async () => {
    const at = new Date(2026, 8, 28, 12, 0, 0);
    await writeFile(path.join(srv.dir, 'reuse_2026-09-28_12-00-00.mp3'), 'x');
    const r = new WavRecorder({ dir: srv.dir, deviceId: 'reuse', format: { sampleRate: 16000, channels: 1, bitsPerSample: 16 }, flushIntervalMs: 1000, startedAt: at });
    assert.equal(r.filename, 'reuse_2026-09-28_12-00-00_1.wav');
    await r.finalize();
  });

  it('falls back to WAV when the encoder is missing', async () => {
    const s2 = await startServer({ RECORDING_FORMAT: 'mp3', LAME_PATH: '/nonexistent/lame' });
    try {
      assert.equal(s2.mic.transcoder, null);
      assert.ok(s2.logs.some((l) => l.includes('was not found; keeping WAV files')));
      const dev = new FakeDevice(s2.ws, 'nolame');
      await dev.connect();
      dev.audio(pcmFrame(1));
      await waitFor(() => s2.mic.devices.get('nolame')!.recording, 'recording');
      dev.kill();
      await waitFor(() => !s2.mic.devices.get('nolame')!.connected, 'disconnect');
      await s2.mic.devices.idle();
      assert.ok((await readdir(s2.dir)).some((f) => f.startsWith('nolame_') && f.endsWith('.wav')));
    } finally {
      await s2.stop();
      await removeDir(s2.dir);
    }
  });
});

describe('parseMp3Start', () => {
  it('reads the bitrate of an MPEG-2 Layer III frame header', () => {
    // FF F3 = MPEG-2 Layer III, no CRC; 0x40 → bitrate index 4 = 32 kbps
    assert.deepEqual(parseMp3Start(Buffer.from([0x00, 0xff, 0xf3, 0x40, 0xc4])), { bitrateKbps: 32, offset: 1 });
  });
  it('returns null for non-MP3 data', () => {
    assert.equal(parseMp3Start(Buffer.from('RIFF....WAVE')), null);
  });
});
