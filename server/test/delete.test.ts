import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { Dashboard, FakeDevice, pcmFrame, removeDir, startServer, waitFor, type TestServer } from './helpers.js';

const del = (srv: TestServer, name: string, headers: Record<string, string> = {}) =>
  fetch(`${srv.http}/recordings/${name}`, { method: 'DELETE', headers });

describe('deleting recordings', () => {
  let srv: TestServer;
  let finished = '';
  let active = '';
  let dev: FakeDevice;

  before(async () => {
    srv = await startServer();
    const a = new FakeDevice(srv.ws, 'del-a');
    await a.connect();
    a.audio(pcmFrame(1));
    await waitFor(() => srv.mic.devices.get('del-a')?.recording, 'recording a');
    finished = srv.mic.devices.get('del-a')!.current_recording!;
    a.kill();
    await waitFor(() => !srv.mic.devices.get('del-a')!.connected, 'a closed');
    await srv.mic.devices.idle();

    dev = new FakeDevice(srv.ws, 'del-live');
    await dev.connect();
    dev.audio(pcmFrame(2));
    await waitFor(() => srv.mic.devices.get('del-live')?.recording, 'recording live');
    active = srv.mic.devices.get('del-live')!.current_recording!;
  });
  after(async () => {
    dev.kill();
    await srv.stop();
    await removeDir(srv.dir);
  });

  it('refuses the recording that is still being written', async () => {
    const r = await del(srv, active);
    assert.equal(r.status, 409);
    assert.ok((await readdir(srv.dir)).includes(active));
  });

  it('refuses bad names, missing files and other origins', async () => {
    assert.equal((await del(srv, '..%2F..%2Fetc%2Fpasswd')).status, 400);
    assert.equal((await del(srv, 'nope_2026-01-01_00-00-00.wav')).status, 404);
    assert.equal((await del(srv, finished, { Origin: 'https://evil.example' })).status, 403);
    assert.ok((await readdir(srv.dir)).includes(finished), 'still there after refused requests');
  });

  it('bulk-deletes finished files and reports what it skipped', async () => {
    // two more finished recordings
    const made: string[] = [];
    for (const id of ['bulk-1', 'bulk-2']) {
      const d = new FakeDevice(srv.ws, id);
      await d.connect();
      d.audio(pcmFrame(3));
      await waitFor(() => srv.mic.devices.get(id)?.recording, `${id} recording`);
      made.push(srv.mic.devices.get(id)!.current_recording!);
      d.kill();
      await waitFor(() => !srv.mic.devices.get(id)!.connected, `${id} closed`);
    }
    await srv.mic.devices.idle();

    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${srv.http}/recordings/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

    assert.equal((await post({ filenames: made }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ filenames: [] })).status, 400);
    assert.equal((await post({ nope: 1 })).status, 400);

    const r = await post({ filenames: [...made, active, 'missing_2026-01-01_00-00-00.wav', '../etc'] }, { Origin: srv.http });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.deleted.sort(), [...made].sort());
    assert.deepEqual(
      body.failed.map((f: any) => [f.filename, f.error]),
      [
        [active, 'recording is still in progress'],
        ['missing_2026-01-01_00-00-00.wav', 'recording not found'],
        ['../etc', 'invalid recording name'],
      ],
    );
    const left = await readdir(srv.dir);
    for (const f of made) assert.ok(!left.includes(f), `${f} removed`);
    assert.ok(left.includes(active), 'live recording untouched');
    assert.ok(srv.logs.some((l) => l.includes('Recordings deleted: 2 file(s)') && l.includes('(3 skipped)')));
  });

  it('deletes a finished recording and updates every dashboard', async () => {
    const dash = new Dashboard(srv.ws);
    await dash.open();
    await waitFor(() => dash.messages.find((m) => m.type === 'snapshot'), 'snapshot');
    const r = await del(srv, finished, { Origin: srv.http });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { deleted: finished });
    assert.ok(!(await readdir(srv.dir)).includes(finished), 'file removed from disk');
    await waitFor(
      () => dash.messages.some((m) => m.type === 'recordings' && !m.recordings.some((x: any) => x.filename === finished)),
      'dashboard push without the deleted file',
    );
    const list = await (await fetch(`${srv.http}/recordings`)).json();
    assert.ok(!list.recordings.some((x: any) => x.filename === finished));
    assert.ok(srv.logs.some((l) => l.includes(`Recording deleted: ${finished}`)));
    assert.equal((await del(srv, finished)).status, 404, 'second delete is a 404');
    dash.close();
  });
});
