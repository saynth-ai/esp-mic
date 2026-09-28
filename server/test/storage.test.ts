import assert from 'node:assert/strict';
import { mkdtemp, open, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { WavRecorder } from '../src/recorder.js';
import { RecordingStore, resolveRecordingPath } from '../src/recordings.js';
import { buildWavHeader, parseWavHeader } from '../src/wav.js';
import { pcmFrame, readWav, removeDir } from './helpers.js';

const FMT = { sampleRate: 16000, channels: 1, bitsPerSample: 16 };

describe('WAV header', () => {
  it('round-trips through the parser', () => {
    const info = parseWavHeader(buildWavHeader(FMT, 64000))!;
    assert.deepEqual(
      { ...info },
      { audioFormat: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16, riffSize: 64036, dataOffset: 44, dataBytes: 64000 },
    );
  });

  it('refuses non-WAV data', () => {
    assert.equal(parseWavHeader(Buffer.from('not a wav file at all, sorry')), null);
  });
});

describe('WavRecorder', () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'esp32-rec-'));
  });
  after(() => removeDir(dir));

  it('never overwrites: same device and second get distinct files', async () => {
    const at = new Date(2026, 8, 28, 11, 30, 45);
    const a = new WavRecorder({ dir, deviceId: 'dev', format: FMT, flushIntervalMs: 1000, startedAt: at });
    const b = new WavRecorder({ dir, deviceId: 'dev', format: FMT, flushIntervalMs: 1000, startedAt: at });
    assert.equal(a.filename, 'dev_2026-09-28_11-30-45.wav');
    assert.equal(b.filename, 'dev_2026-09-28_11-30-45_1.wav');
    a.write(pcmFrame(1));
    b.write(pcmFrame(2));
    await Promise.all([a.finalize(), b.finalize()]);
    const c = new WavRecorder({ dir, deviceId: 'dev', format: FMT, flushIntervalMs: 1000, startedAt: at });
    assert.equal(c.filename, 'dev_2026-09-28_11-30-45_2.wav', 'existing files on disk are skipped too');
    await c.finalize();
    assert.ok((await readWav(path.join(dir, a.filename))).data.equals(pcmFrame(1)));
    assert.ok((await readWav(path.join(dir, b.filename))).data.equals(pcmFrame(2)));
  });

  it('keeps the header valid on disk while recording (crash safety)', async () => {
    const r = new WavRecorder({ dir, deviceId: 'crash', format: FMT, flushIntervalMs: 50 });
    for (let i = 0; i < 10; i++) r.write(pcmFrame(i));
    await r.flush();
    // Simulate the process dying here: never call finalize(), read the file as-is.
    const w = await readWav(r.path);
    assert.equal(w.info.dataBytes, 10 * 2048);
    assert.equal(w.info.riffSize, w.size - 8);
    await r.finalize();
  });

  it('reports write errors instead of throwing', async () => {
    const errors: Error[] = [];
    const r = new WavRecorder({
      dir: path.join(dir, 'does-not-exist'),
      deviceId: 'x',
      format: FMT,
      flushIntervalMs: 1000,
      onError: (e) => errors.push(e),
    });
    r.write(pcmFrame(1));
    const done = await r.finalize();
    assert.equal(errors.length, 1);
    assert.ok(done.error);
    assert.equal(r.write(pcmFrame(2)), false);
  });
});

describe('RecordingStore', () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'esp32-store-'));
  });
  after(() => removeDir(dir));

  it('repairs headers left stale by a crash, including a torn last sample', async () => {
    const name = 'crashy_2026-09-28_10-00-00.wav';
    const data = Buffer.concat([pcmFrame(1), pcmFrame(2), Buffer.from([7])]); // odd trailing byte
    await writeFile(path.join(dir, name), Buffer.concat([buildWavHeader(FMT, 2048), data])); // header says 1 frame

    const empty = 'empty_2026-09-28_10-00-01.wav';
    await (await open(path.join(dir, empty), 'w')).close(); // 0 bytes: died before the header write

    const store = new RecordingStore(dir, FMT, silentLogger);
    await store.init();

    const w = await readWav(path.join(dir, name));
    assert.equal(w.info.dataBytes, 4096);
    assert.equal(w.size, 44 + 4096, 'odd trailing byte truncated');
    assert.equal(w.info.riffSize, w.size - 8);
    assert.equal((await stat(path.join(dir, empty))).size, 44);

    const list = await store.list();
    const rec = list.find((r) => r.filename === name)!;
    assert.equal(rec.device_id, 'crashy');
    assert.equal(rec.duration_seconds, 0.1);
    assert.equal(rec.started_at, new Date(2026, 8, 28, 10, 0, 0).toISOString());
    assert.equal((await store.stats(list)).recordings, 2);
  });

  it('ignores non-recording files', async () => {
    await writeFile(path.join(dir, 'notes.txt'), 'hi');
    await writeFile(path.join(dir, '.hidden.wav'), 'x');
    const store = new RecordingStore(dir, FMT, silentLogger);
    assert.equal((await store.list()).length, 2);
    assert.ok((await readdir(dir)).includes('notes.txt'));
  });
});

describe('resolveRecordingPath', () => {
  const root = '/srv/recordings';
  it('accepts server-generated names', () => {
    assert.equal(resolveRecordingPath(root, 'esp32-mic-001_2026-09-28_11-30-45.wav'), '/srv/recordings/esp32-mic-001_2026-09-28_11-30-45.wav');
  });
  it('refuses traversal, absolute paths and odd names', () => {
    for (const bad of ['../x.wav', '..', '/etc/passwd', 'a/b.wav', 'a\\b.wav', '.x.wav', 'x.WAV.txt', 'x.txt', '', 'x\0.wav', '..wav']) {
      assert.equal(resolveRecordingPath(root, bad), null, bad);
    }
  });
});

describe('config', () => {
  it('requires a device token', () => {
    assert.throws(() => loadConfig({}), ConfigError);
  });
  it('parses CORS and token lists', () => {
    const c = loadConfig({ DEVICE_TOKEN: 'a, b', CORS_ORIGINS: 'http://x.test, http://y.test' });
    assert.deepEqual(c.deviceTokens, ['a', 'b']);
    assert.deepEqual(c.corsOrigins, ['http://x.test', 'http://y.test']);
    assert.equal(loadConfig({ DEVICE_TOKEN: 'a', CORS_ORIGINS: '*' }).corsOrigins, '*');
  });
  it('rejects nonsense numbers', () => {
    assert.throws(() => loadConfig({ DEVICE_TOKEN: 'a', AUDIO_TIMEOUT_MS: 'soon' }), /AUDIO_TIMEOUT_MS/);
  });
});
