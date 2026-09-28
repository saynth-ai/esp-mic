import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { FakeDevice, pcmFrame, removeDir, startServer, waitFor, type TestServer } from './helpers.js';

function listen(url: string, origin?: string): Promise<{ ws: WebSocket; frames: Buffer[]; texts: any[]; status: number | null }> {
  return new Promise((resolve) => {
    const out = { ws: new WebSocket(url, origin ? { origin } : {}), frames: [] as Buffer[], texts: [] as any[], status: null as number | null };
    out.ws.on('unexpected-response', (_req, res) => resolve({ ...out, status: res.statusCode ?? -1 }));
    out.ws.on('error', () => {});
    out.ws.on('message', (d, isBinary) => (isBinary ? out.frames.push(d as Buffer) : out.texts.push(JSON.parse(d.toString()))));
    out.ws.on('open', () => resolve(out));
  });
}

describe('live listening', () => {
  let srv: TestServer;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.stop();
    await removeDir(srv.dir);
  });

  it('forwards each device frame, byte for byte, to its live listeners only', async () => {
    const a = await listen(`${srv.ws}/ws/live?device=live-a`);
    const b = await listen(`${srv.ws}/ws/live?device=live-b`);
    await waitFor(() => a.texts.length && b.texts.length, 'live hello');
    assert.deepEqual(a.texts[0], { type: 'live', device_id: 'live-a', sample_rate: 16000, format: 'pcm_s16le', channels: 1 });

    const dev = new FakeDevice(srv.ws, 'live-a');
    await dev.connect();
    for (let i = 0; i < 10; i++) dev.audio(pcmFrame(i));
    await waitFor(() => a.frames.length === 10, 'frames at listener');
    assert.ok(Buffer.concat(a.frames).equals(dev.sentBytes));
    assert.equal(b.frames.length, 0, 'other device listeners get nothing');
    assert.equal(srv.mic.ws.liveListeners(), 2);

    a.ws.close();
    b.ws.close();
    await waitFor(() => srv.mic.ws.liveListeners() === 0, 'listeners detached');
    dev.kill();
  });

  it('a listener can attach before the device connects and keeps listening across reconnects', async () => {
    const l = await listen(`${srv.ws}/ws/live?device=live-c`);
    for (let round = 0; round < 2; round++) {
      const dev = new FakeDevice(srv.ws, 'live-c');
      await dev.connect();
      dev.audio(pcmFrame(round));
      await waitFor(() => l.frames.length === round + 1, `frame ${round}`);
      dev.kill();
      await waitFor(() => !srv.mic.devices.get('live-c')!.connected, 'disconnect');
    }
    l.ws.close();
  });

  it('rejects bad device ids and foreign origins', async () => {
    assert.equal((await listen(`${srv.ws}/ws/live?device=../../etc`)).status, 400);
    assert.equal((await listen(`${srv.ws}/ws/live`)).status, 400);
    assert.equal((await listen(`${srv.ws}/ws/live?device=x`, 'https://evil.example')).status, 403);
  });
});
