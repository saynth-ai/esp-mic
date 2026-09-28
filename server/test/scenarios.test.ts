/**
 * End-to-end acceptance scenarios, run against the real server (HTTP + both
 * WebSockets + disk) with simulated ESP32 devices.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Dashboard, FakeDevice, pcmFrame, readWav, removeDir, startServer, waitFor, type TestServer } from './helpers.js';

const wavs = async (dir: string) => (await readdir(dir)).filter((f) => f.endsWith('.wav')).sort();

describe('ESP32 mic server — acceptance scenarios', () => {
  let srv: TestServer;
  let dash: Dashboard;
  let dev: FakeDevice;
  let firstFile: string;
  const ID = 'esp32-mic-001';

  before(async () => {
    srv = await startServer();
    dash = new Dashboard(srv.ws);
    assert.equal(await dash.open(), null);
    await waitFor(() => dash.messages.find((m) => m.type === 'snapshot'), 'dashboard snapshot');
  });

  after(async () => {
    dash.close();
    await srv.stop();
    await removeDir(srv.dir);
  });

  it('1+2. ESP32 connects and its WebSocket is accepted after hello', async () => {
    dev = new FakeDevice(srv.ws, ID);
    await dev.connect();
    const welcome = dev.messages.find((m) => m.type === 'welcome');
    assert.equal(welcome.sample_rate, 16000);

    const devices = await (await fetch(`${srv.http}/api/devices`)).json();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].device_id, ID);
    assert.equal(devices[0].connected, true);
    assert.equal(devices[0].streaming, false, 'connected but no audio yet');
    assert.equal(devices[0].ip, '192.168.1.50');
    assert.ok(srv.logs.some((l) => l.includes('[INFO] ESP32 connected: esp32-mic-001')));
  });

  it('3+4. audio starts recording automatically and a WAV file is created', async () => {
    await dev.stream(5, 1);
    const files = await waitFor(async () => ((await wavs(srv.dir)).length === 1 ? wavs(srv.dir) : null), 'wav file');
    firstFile = files[0]!;
    assert.match(firstFile, /^esp32-mic-001_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.wav$/);
    const d = srv.mic.devices.get(ID)!;
    assert.equal(d.streaming, true);
    assert.equal(d.recording, true);
    assert.equal(d.current_recording, firstFile);
    assert.ok(srv.logs.some((l) => l.includes('audio stream started')));
    assert.ok(srv.logs.some((l) => l.includes(`Recording started: ${firstFile}`)));
  });

  it('5. audio keeps streaming and is flushed to disk while recording', async () => {
    await dev.stream(20, 100);
    await waitFor(() => srv.mic.devices.get(ID)!.packets_received === 25, '25 packets counted');
    // Timed flush writes data and patches the header while the file is still open.
    const wav = await waitFor(async () => {
      const w = await readWav(path.join(srv.dir, firstFile));
      return w.info.dataBytes === 25 * 2048 ? w : null;
    }, 'periodic flush');
    assert.equal(wav.size, 44 + 25 * 2048);
    assert.equal(srv.mic.devices.get(ID)!.bytes_received, 25 * 2048);
  });

  it('6. dashboard receives real-time status pushes', async () => {
    const pushes = dash.statuses(ID);
    assert.ok(pushes.some((s) => s.connected && !s.streaming), 'saw connected/idle');
    assert.ok(pushes.some((s) => s.streaming && s.recording), 'saw streaming/recording');
    const last = await waitFor(() => {
      const s = dash.statuses(ID).at(-1);
      return s && s.packets_received === 25 ? s : null;
    }, 'status with final counters');
    assert.equal(last.bytes_received, 25 * 2048);
    assert.equal(last.current_recording, firstFile);
    assert.equal(last.sample_rate, 16000);
    assert.ok(dash.messages.some((m) => m.type === 'recordings' && m.recordings.some((r: any) => r.filename === firstFile && r.active)));
  });

  it('7+8. abrupt disconnect finalizes the WAV with correct sizes', async () => {
    dev.kill();
    await waitFor(() => srv.mic.devices.get(ID)!.connected === false, 'device marked disconnected');
    await srv.mic.devices.idle();
    const wav = await readWav(path.join(srv.dir, firstFile));
    const sent = dev.sentBytes;
    assert.equal(wav.info.dataBytes, sent.length);
    assert.equal(wav.info.riffSize, wav.size - 8);
    assert.equal(wav.info.sampleRate, 16000);
    assert.equal(wav.info.bitsPerSample, 16);
    assert.equal(wav.info.channels, 1);
    assert.equal(wav.info.audioFormat, 1);
    assert.ok(wav.data.equals(sent), 'recorded samples are byte-identical to what was sent');
    assert.ok(srv.logs.some((l) => l.includes(`Recording saved: ${firstFile}`)));
    assert.ok(srv.logs.some((l) => l.includes('ESP32 disconnected: esp32-mic-001')));
    const s = dash.statuses(ID).at(-1);
    assert.equal(s.connected, false);
    assert.equal(s.recording, false);
  });

  it('9+10. device reconnects and a new recording is created', async () => {
    dev = new FakeDevice(srv.ws, ID);
    await dev.connect();
    await dev.stream(3, 500);
    const files = await waitFor(async () => {
      const f = await wavs(srv.dir);
      return f.length === 2 ? f : null;
    }, 'second recording');
    assert.ok(files.includes(firstFile), 'first recording untouched');
    const second = files.find((f) => f !== firstFile)!;
    assert.equal(srv.mic.devices.get(ID)!.current_recording, second);
    assert.equal(srv.mic.devices.get(ID)!.packets_received, 3, 'counters reset for the new connection');
    dev.send({ type: 'stop' });
    await waitFor(() => !srv.mic.devices.get(ID)!.recording, 'stop finalizes');
    await srv.mic.devices.idle();
    assert.equal((await readWav(path.join(srv.dir, second))).info.dataBytes, 3 * 2048);
    dev.ws.close();
    await dev.closed();
  });

  it('11. recordings survive a server restart', async () => {
    const before = await (await fetch(`${srv.http}/recordings`)).json();
    dash.close();
    await srv.stop();

    srv = await startServer({}, srv.dir);
    dash = new Dashboard(srv.ws);
    await dash.open();
    const snap = await waitFor(() => dash.messages.find((m) => m.type === 'snapshot'), 'snapshot after restart');
    assert.equal(snap.storage.recordings, 2);

    const afterList = await (await fetch(`${srv.http}/recordings`)).json();
    assert.deepEqual(
      afterList.recordings.map((r: any) => [r.filename, r.duration_seconds, r.size_bytes]),
      before.recordings.map((r: any) => [r.filename, r.duration_seconds, r.size_bytes]),
    );
    const health = await (await fetch(`${srv.http}/api/health`)).json();
    assert.equal(health.status, 'ok');
    assert.equal(health.recordings, 2);
    assert.equal(health.devices_connected, 0);
  });

  it('12. browser can play (with Range) and download recordings', async () => {
    const list = await (await fetch(`${srv.http}/recordings`)).json();
    const rec = list.recordings.find((r: any) => r.filename === firstFile);
    assert.equal(rec.device_id, ID);
    assert.equal(rec.duration_seconds, Math.round(((25 * 2048) / 32000) * 10) / 10);

    const onDisk = await readFile(path.join(srv.dir, firstFile));
    const play = await fetch(`${srv.http}/recordings/${firstFile}`);
    assert.equal(play.status, 200);
    assert.equal(play.headers.get('content-type'), 'audio/wav');
    assert.equal(play.headers.get('accept-ranges'), 'bytes');
    assert.ok(Buffer.from(await play.arrayBuffer()).equals(onDisk));

    const range = await fetch(`${srv.http}/recordings/${firstFile}`, { headers: { Range: 'bytes=0-43' } });
    assert.equal(range.status, 206, 'seeking in <audio> needs range support');
    assert.equal((await range.arrayBuffer()).byteLength, 44);

    const dl = await fetch(`${srv.http}/recordings/${firstFile}?download=1`);
    assert.match(dl.headers.get('content-disposition') ?? '', new RegExp(`attachment; filename="${firstFile}"`));
    await dl.arrayBuffer();

    const html = await fetch(`${srv.http}/`);
    assert.match(await html.text(), /ESP32 Mic Recorder/);
  });

  it('13. invalid or missing device token is rejected before the upgrade', async () => {
    const bad = new FakeDevice(srv.ws, 'intruder', 'wrong-token');
    assert.equal(await bad.open(), 401);
    const none = new FakeDevice(srv.ws, 'intruder', null);
    assert.equal(await none.open(), 401);
    assert.ok(srv.logs.some((l) => l.includes('[WARN] Rejected device connection') && l.includes('invalid or missing token')));
    assert.equal(srv.mic.devices.get('intruder'), null);
  });

  it('14. multiple devices record simultaneously without overwriting each other', async () => {
    const a = new FakeDevice(srv.ws, 'esp32-mic-A');
    const b = new FakeDevice(srv.ws, 'esp32-mic-B');
    await Promise.all([a.connect(), b.connect()]);
    // Interleave frames from both devices.
    for (let i = 0; i < 15; i++) {
      a.audio(pcmFrame(1000 + i));
      b.audio(pcmFrame(5000 + i, 512));
    }
    await waitFor(
      () => srv.mic.devices.get('esp32-mic-A')!.packets_received === 15 && srv.mic.devices.get('esp32-mic-B')!.packets_received === 15,
      'both streams counted',
    );
    const fa = srv.mic.devices.get('esp32-mic-A')!.current_recording!;
    const fb = srv.mic.devices.get('esp32-mic-B')!.current_recording!;
    assert.notEqual(fa, fb);
    a.kill();
    b.kill();
    await waitFor(() => srv.mic.devices.connectedCount() === 0, 'both disconnected');
    await srv.mic.devices.idle();

    assert.ok((await readWav(path.join(srv.dir, fa))).data.equals(a.sentBytes));
    assert.ok((await readWav(path.join(srv.dir, fb))).data.equals(b.sentBytes));
    assert.equal((await wavs(srv.dir)).length, 4);
  });
});

describe('recording lifecycle', () => {
  let srv: TestServer;
  before(async () => {
    srv = await startServer({ MAX_RECORDING_SECONDS: '1' });
  });
  after(async () => {
    await srv.stop();
    await removeDir(srv.dir);
  });

  it('inactivity timeout closes the recording but the WebSocket stays connected', async () => {
    const dev = new FakeDevice(srv.ws, 'idle-dev');
    await dev.connect();
    await dev.stream(3, 1, 0);
    await waitFor(() => srv.mic.devices.get('idle-dev')!.recording, 'recording');
    await waitFor(() => !srv.mic.devices.get('idle-dev')!.recording, 'timeout finalize', 2000);
    const s = srv.mic.devices.get('idle-dev')!;
    assert.equal(s.connected, true);
    assert.equal(s.streaming, false);
    assert.ok(srv.logs.some((l) => l.includes('no audio for 400 ms (WebSocket still connected)')));

    // Audio resumes → a fresh recording starts automatically.
    await dev.stream(2, 9, 0);
    await waitFor(() => srv.mic.devices.get('idle-dev')!.recording, 'second recording');
    await srv.mic.devices.idle();
    const files = (await readdir(srv.dir)).filter((f) => f.startsWith('idle-dev_'));
    assert.equal(files.length, 2);
    dev.kill();
  });

  it('long streams roll over into a new file at MAX_RECORDING_SECONDS', async () => {
    const dev = new FakeDevice(srv.ws, 'long-dev');
    await dev.connect();
    await dev.stream(40, 1, 0); // 40 × 2048 B = 2.56 s of audio at 32000 B/s
    await waitFor(() => srv.mic.devices.get('long-dev')!.packets_received === 40, 'frames');
    dev.kill();
    await waitFor(() => !srv.mic.devices.get('long-dev')!.connected, 'disconnect');
    await srv.mic.devices.idle();
    const files = (await readdir(srv.dir)).filter((f) => f.startsWith('long-dev_')).sort();
    assert.equal(files.length, 3, '1 s + 1 s + remainder');
    const parts = await Promise.all(files.map((f) => readWav(path.join(srv.dir, f))));
    assert.ok(Buffer.concat(parts.map((p) => p.data)).equals(dev.sentBytes), 'no audio lost across the split');
  });
});

describe('protocol validation and security', () => {
  let srv: TestServer;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.stop();
    await removeDir(srv.dir);
  });

  it('rejects a hello with the wrong audio format', async () => {
    const dev = new FakeDevice(srv.ws, 'stereo-dev');
    assert.equal(await dev.open(), null);
    dev.send({ type: 'hello', device_id: 'stereo-dev', sample_rate: 44100, bits: 16, channels: 2, format: 'pcm_s16le' });
    assert.equal(await dev.closed(), 4003);
    assert.match(dev.messages[0].message, /sample_rate 44100/);
  });

  it('rejects audio sent before hello', async () => {
    const dev = new FakeDevice(srv.ws, 'rude-dev');
    await dev.open();
    dev.audio(pcmFrame(1));
    assert.equal(await dev.closed(), 4002);
  });

  it('rejects an unsafe device_id', async () => {
    const dev = new FakeDevice(srv.ws, '../../etc');
    await dev.open();
    dev.send({ type: 'hello', device_id: '../../etc', sample_rate: 16000, bits: 16, channels: 1, format: 'pcm_s16le' });
    assert.equal(await dev.closed(), 4002);
  });

  it('closes a connection that never says hello', async () => {
    const dev = new FakeDevice(srv.ws, 'silent');
    await dev.open();
    assert.equal(await dev.closed(), 4005);
  });

  it('drops odd-length frames without corrupting the recording', async () => {
    const dev = new FakeDevice(srv.ws, 'odd-dev');
    await dev.connect();
    dev.audio(pcmFrame(1));
    dev.ws.send(Buffer.alloc(3), { binary: true });
    dev.audio(pcmFrame(2));
    await waitFor(() => srv.mic.devices.get('odd-dev')!.invalid_frames === 1, 'invalid frame counted');
    await waitFor(() => srv.mic.devices.get('odd-dev')!.packets_received === 2, 'valid frames counted');
    dev.kill();
    await waitFor(() => !srv.mic.devices.get('odd-dev')!.connected, 'disconnect');
    await srv.mic.devices.idle();
    const file = (await readdir(srv.dir)).find((f) => f.startsWith('odd-dev_'))!;
    assert.ok((await readWav(path.join(srv.dir, file))).data.equals(dev.sentBytes));
  });

  it('a second connection with the same device_id replaces the first', async () => {
    const one = new FakeDevice(srv.ws, 'dup-dev');
    await one.connect();
    const two = new FakeDevice(srv.ws, 'dup-dev');
    await two.connect();
    assert.equal(await one.closed(), 4004);
    assert.equal(srv.mic.devices.get('dup-dev')!.connected, true);
    two.kill();
  });

  it('never serves files outside the recordings directory', async () => {
    const attempts = [
      '/recordings/..%2F..%2F..%2Fetc%2Fpasswd',
      '/recordings/%2Fetc%2Fpasswd',
      '/recordings/..%5C..%5Cpackage.json',
      '/recordings/.hidden.wav',
      '/recordings/..wav',
      '/recordings/foo%00.wav',
      '/recordings/package.json',
      '/recordings/../package.json',
    ];
    for (const p of attempts) {
      const res = await fetch(`${srv.http}${p}`);
      const body = await res.text();
      assert.ok([400, 404].includes(res.status), `${p} → ${res.status}`);
      assert.doesNotMatch(body, /root:|"dependencies"/, `${p} leaked a file`);
    }
    const missing = await fetch(`${srv.http}/recordings/nope_2026-01-01_00-00-00.wav`);
    assert.equal(missing.status, 404);
  });

  it('dashboard WebSocket enforces the CORS origin policy', async () => {
    const same = new Dashboard(srv.ws);
    assert.equal(await same.open(srv.http), null);
    same.close();
    const evil = new Dashboard(srv.ws);
    assert.equal(await evil.open('https://evil.example'), 403);
  });

  it('health and devices endpoints respond', async () => {
    const h = await (await fetch(`${srv.http}/api/health`)).json();
    assert.equal(h.status, 'ok');
    assert.equal(typeof h.uptime, 'number');
    const res = await fetch(`${srv.http}/api/devices`);
    assert.ok(Array.isArray(await res.json()));
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'no CORS by default');
  });
});
