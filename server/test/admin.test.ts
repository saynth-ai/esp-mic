import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { AdminAuth, LoginLimiter } from '../src/admin.js';
import { FakeDevice, pcmFrame, removeDir, startServer, waitFor, type TestServer } from './helpers.js';

const PASSWORD = 'correct-horse-battery-staple';

function wsStatus(url: string, cookie?: string): Promise<number | 'open'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, cookie ? { headers: { Cookie: cookie } } : {});
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? -1));
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('error', () => {});
  });
}

async function login(srv: TestServer, username: string, password: string): Promise<Response> {
  return fetch(`${srv.http}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }).toString(),
  });
}

describe('admin login', () => {
  let srv: TestServer;
  let cookie = '';
  before(async () => {
    srv = await startServer({ ADMIN_USER: 'admin', ADMIN_PASSWORD: PASSWORD, SESSION_SECRET: 's3cret' });
  });
  after(async () => {
    await srv.stop();
    await removeDir(srv.dir);
  });

  it('protects the dashboard, API, recordings and browser WebSockets', async () => {
    const page = await fetch(`${srv.http}/`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login');
    assert.equal((await fetch(`${srv.http}/api/devices`)).status, 401);
    assert.equal((await fetch(`${srv.http}/recordings`)).status, 401);
    assert.equal((await fetch(`${srv.http}/recordings/x_2026-01-01_00-00-00.wav`)).status, 401);
    assert.equal((await fetch(`${srv.http}/recordings/x_2026-01-01_00-00-00.wav`, { method: 'DELETE' })).status, 401, 'delete needs login');
    assert.equal((await fetch(`${srv.http}/recordings/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"filenames":["x"]}' })).status, 401, 'bulk delete needs login');
    assert.equal(await wsStatus(`${srv.ws}/ws`), 401);
    assert.equal(await wsStatus(`${srv.ws}/ws/live?device=x`), 401);
  });

  it('keeps health, the login page and its stylesheet public', async () => {
    assert.equal((await fetch(`${srv.http}/api/health`)).status, 200);
    const loginPage = await fetch(`${srv.http}/login`);
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /<form class="login card" method="post" action="\/login">/);
    assert.equal((await fetch(`${srv.http}/style.css`)).status, 200);
  });

  it('rejects a wrong password and accepts the right one', async () => {
    const bad = await login(srv, 'admin', 'nope');
    assert.equal(bad.headers.get('location'), '/login?error=1');
    assert.equal(bad.headers.get('set-cookie'), null);
    assert.ok(srv.logs.some((l) => l.includes('[WARN] Failed dashboard login')));

    const good = await login(srv, 'admin', PASSWORD);
    assert.equal(good.status, 303);
    assert.equal(good.headers.get('location'), '/');
    const set = good.headers.get('set-cookie')!;
    assert.match(set, /mic_session=\d+\.[0-9a-f]{64}/);
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Lax/);
    cookie = set.split(';')[0]!;
  });

  it('a valid session opens everything', async () => {
    const page = await fetch(`${srv.http}/`, { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /ESP32 Mic Recorder/);
    assert.equal((await fetch(`${srv.http}/api/devices`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal(await wsStatus(`${srv.ws}/ws`, cookie), 'open');
    assert.equal(await wsStatus(`${srv.ws}/ws/live?device=x`, cookie), 'open');
  });

  it('forged or tampered cookies are rejected', async () => {
    const [exp] = cookie.slice('mic_session='.length).split('.');
    for (const bad of [`mic_session=${exp}.${'0'.repeat(64)}`, `mic_session=${Number(exp) + 1000}.${cookie.split('.')[1]}`, 'mic_session=garbage']) {
      assert.equal((await fetch(`${srv.http}/api/devices`, { headers: { Cookie: bad } })).status, 401, bad);
    }
  });

  it('devices still connect with their token, without any login', async () => {
    const dev = new FakeDevice(srv.ws, 'authed-dev');
    await dev.connect();
    dev.audio(pcmFrame(1));
    await waitFor(() => srv.mic.devices.get('authed-dev')?.packets_received === 1, 'device audio');
    dev.kill();
  });

  it('logout clears the cookie', async () => {
    const r = await fetch(`${srv.http}/logout`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie } });
    assert.equal(r.headers.get('location'), '/login');
    assert.match(r.headers.get('set-cookie')!, /mic_session=;/);
  });

  it('rate-limits repeated failed logins', async () => {
    for (let i = 0; i < 10; i++) await login(srv, 'admin', `wrong-${i}`);
    const blocked = await login(srv, 'admin', PASSWORD);
    assert.equal(blocked.headers.get('location'), '/login?limited=1', 'even the right password is refused while blocked');
    assert.equal(blocked.headers.get('set-cookie'), null);
  });
});

describe('client address behind Cloudflare', () => {
  it('prefers CF-Connecting-IP over a spoofable X-Forwarded-For', async () => {
    const { remoteAddress } = await import('../src/websocket.js');
    const req = (h: Record<string, string>) => ({ headers: h, socket: { remoteAddress: '::ffff:10.0.0.1' } }) as any;
    assert.equal(remoteAddress(req({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }), true), '203.0.113.9');
    assert.equal(remoteAddress(req({ 'x-forwarded-for': '198.51.100.7, 10.0.0.2' }), true), '198.51.100.7');
    assert.equal(remoteAddress(req({ 'cf-connecting-ip': '203.0.113.9' }), false), '10.0.0.1', 'headers ignored unless TRUST_PROXY');
  });
});

describe('AdminAuth unit', () => {
  const auth = new AdminAuth({ user: 'admin', password: 'pw-123456789012', sessionSecret: 'x', sessionTtlMs: 1000 });
  it('expires sessions', () => {
    const t = auth.issue(0);
    assert.equal(auth.verify(t, 500), true);
    assert.equal(auth.verify(t, 1001), false);
  });
  it('changing the password invalidates existing sessions', () => {
    const t = auth.issue();
    const other = new AdminAuth({ user: 'admin', password: 'another-password', sessionSecret: 'x', sessionTtlMs: 1000 });
    assert.equal(other.verify(t), false);
  });
  it('limiter resets after its window', () => {
    const l = new LoginLimiter(2, 100);
    l.fail('a', 0);
    l.fail('a', 1);
    assert.equal(l.blocked('a', 50), true);
    assert.equal(l.blocked('a', 101), false);
  });
});
