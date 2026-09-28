import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { AdminAuth, LoginLimiter, readCookie, SESSION_COOKIE } from './admin.js';
import type { Config } from './config.js';
import { corsMiddleware, isOriginAllowed } from './cors.js';
import { DeviceManager } from './devices.js';
import type { Logger } from './logger.js';
import { contentTypeFor, RecordingStore, resolveRecordingPath } from './recordings.js';
import { Mp3Transcoder } from './transcoder.js';
import { attachWebSockets, remoteAddress, type WebSocketLayer } from './websocket.js';

export const VERSION = '1.1.0';

/** Works from src/ (tsx) and dist/src/ (compiled). */
function findPublicDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return here.includes(`${path.sep}dist${path.sep}`) ? path.resolve(here, '../../public') : path.resolve(here, '../public');
}

export interface MicServer {
  config: Config;
  http: http.Server;
  devices: DeviceManager;
  store: RecordingStore;
  ws: WebSocketLayer;
  /** Null when recordings are kept as WAV. */
  transcoder: Mp3Transcoder | null;
  listen(): Promise<AddressInfo>;
  /** Finalize every open recording, close all sockets, stop listening. */
  close(): Promise<void>;
}

export async function createMicServer(config: Config, log: Logger): Promise<MicServer> {
  const store = new RecordingStore(config.recordingsDir, {
    sampleRate: config.audio.sampleRate,
    channels: config.audio.channels,
    bitsPerSample: config.audio.bitsPerSample,
  }, log);
  await store.init();

  // MP3 storage: finished WAVs are converted in the background by LAME.
  let transcoder: Mp3Transcoder | null = null;
  if (config.recordingFormat === 'mp3') {
    transcoder = new Mp3Transcoder({ lamePath: config.lamePath, bitrateKbps: config.mp3BitrateKbps }, log);
    const version = await transcoder.probe();
    if (version) {
      log.info(`Recordings are stored as MP3 (${config.mp3BitrateKbps} kbps CBR, ${version})`);
    } else {
      log.error(`RECORDING_FORMAT=mp3 but the LAME encoder "${config.lamePath}" was not found; keeping WAV files`);
      transcoder = null;
    }
  }

  const devices = new DeviceManager(config, store, log);
  if (transcoder) {
    const t = transcoder;
    devices.on('recordingSaved', (_id, rec) => {
      if (rec.dataBytes === 0) return;
      void t.enqueue(rec.path).then(() => devices.emit('recordings'));
    });
    // Recordings finished before a crash or restart that were never converted.
    const leftovers = await store.finishedWavs();
    if (leftovers.length) log.info(`Converting ${leftovers.length} earlier WAV recording(s) to MP3`);
    for (const wav of leftovers) void t.enqueue(wav).then(() => devices.emit('recordings'));
  }
  const startedAt = new Date();
  const uptime = () => Math.round((Date.now() - startedAt.getTime()) / 1000);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; connect-src 'self' ws: wss:; media-src 'self' blob:; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    );
    next();
  });
  app.use(corsMiddleware(config));

  // ---------------------------------------------------------------- admin login
  const admin = config.admin.password
    ? new AdminAuth({
        user: config.admin.user,
        password: config.admin.password,
        sessionSecret: config.admin.sessionSecret,
        sessionTtlMs: config.admin.sessionTtlMs,
      })
    : null;
  const limiter = new LoginLimiter();

  if (admin) {
    app.get('/login', (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(loginPage(req.query.error === '1', req.query.limited === '1'));
    });

    app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
      const client = remoteAddress(req, config.trustProxy) ?? 'unknown';
      if (limiter.blocked(client)) {
        log.warn(`Login blocked for ${client}: too many failed attempts`);
        res.redirect(303, '/login?limited=1');
        return;
      }
      const user = typeof req.body?.username === 'string' ? req.body.username : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!admin.checkCredentials(user, password)) {
        limiter.fail(client);
        log.warn(`Failed dashboard login from ${client}`);
        res.redirect(303, '/login?error=1');
        return;
      }
      limiter.succeed(client);
      log.info(`Dashboard login from ${client}`);
      res.cookie(SESSION_COOKIE, admin.issue(), {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure, // true behind HTTPS (Cloudflare/nginx set X-Forwarded-Proto)
        maxAge: admin.ttlMs,
        path: '/',
      });
      res.redirect(303, '/');
    });

    app.post('/logout', (_req, res) => {
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.redirect(303, '/login');
    });
  }

  app.get('/api/health', async (_req, res) => {
    res.json({
      status: 'ok',
      uptime: uptime(),
      devices_connected: devices.connectedCount(),
      recordings: await store.count(),
      conversions_pending: transcoder?.queued ?? 0,
      version: VERSION,
    });
  });

  // Everything below requires a dashboard session (when ADMIN_PASSWORD is set).
  // /api/health stays public for uptime monitoring; it exposes only counts.
  const PUBLIC_PATHS = new Set(['/login', '/style.css', '/favicon.ico']);
  app.use((req, res, next) => {
    if (!admin || PUBLIC_PATHS.has(req.path) || admin.verify(readCookie(req.headers.cookie, SESSION_COOKIE))) {
      next();
      return;
    }
    if (req.path.startsWith('/api/') || req.path.startsWith('/recordings')) {
      res.status(401).json({ error: 'login required' });
      return;
    }
    res.redirect(302, '/login');
  });

  app.get('/api/devices', (_req, res) => {
    res.json(devices.list().map(({ type: _type, ...d }) => d));
  });

  app.get('/api/devices/:deviceId', (req, res) => {
    const d = devices.get(req.params.deviceId);
    if (!d) {
      res.status(404).json({ error: 'unknown device' });
      return;
    }
    const { type: _type, ...rest } = d;
    res.json(rest);
  });

  const listRecordings = async (_req: Request, res: Response) => {
    const recordings = await store.list();
    res.setHeader('Cache-Control', 'no-store');
    res.json({ recordings, storage: await store.stats(recordings) });
  };
  app.get('/recordings', listRecordings);
  app.get('/api/recordings', listRecordings);

  // Deletion shared by the single and bulk endpoints: returns null on success, or [status, reason].
  const deleteOne = async (name: string): Promise<[number, string] | null> => {
    const full = resolveRecordingPath(store.dir, name);
    if (!full) return [400, 'invalid recording name'];
    if (store.isActive(name)) return [409, 'recording is still in progress'];
    if (transcoder?.isQueued(full)) return [409, 'recording is being converted to MP3; try again in a moment'];
    if (!(await store.remove(name))) return [404, 'recording not found'];
    return null;
  };
  // State-changing requests: refuse other sites even though the session cookie is SameSite=Lax.
  const sameOrigin = (req: Request) =>
    isOriginAllowed(typeof req.headers.origin === 'string' ? req.headers.origin : undefined, req.headers.host, config);

  app.delete('/recordings/:filename', async (req, res) => {
    if (!sameOrigin(req)) {
      res.status(403).json({ error: 'cross-origin request refused' });
      return;
    }
    const name = req.params.filename;
    const err = await deleteOne(name);
    if (err) {
      res.status(err[0]).json({ error: err[1] });
      return;
    }
    log.info(`Recording deleted: ${name} (by ${remoteAddress(req, config.trustProxy) ?? 'unknown'})`);
    devices.emit('recordings');
    res.json({ deleted: name });
  });

  // Bulk delete: {"filenames": [...]} → {"deleted": [...], "failed": [{filename, error}]}
  app.post('/recordings/delete', express.json({ limit: '64kb' }), async (req, res) => {
    if (!sameOrigin(req)) {
      res.status(403).json({ error: 'cross-origin request refused' });
      return;
    }
    const names: unknown = req.body?.filenames;
    if (!Array.isArray(names) || names.length === 0 || names.length > 1000 || !names.every((n) => typeof n === 'string')) {
      res.status(400).json({ error: 'expected {"filenames": [...]} with 1-1000 names' });
      return;
    }
    const deleted: string[] = [];
    const failed: { filename: string; error: string }[] = [];
    for (const name of new Set(names as string[])) {
      const err = await deleteOne(name);
      if (err) failed.push({ filename: name, error: err[1] });
      else deleted.push(name);
    }
    if (deleted.length) {
      log.info(
        `Recordings deleted: ${deleted.length} file(s) by ${remoteAddress(req, config.trustProxy) ?? 'unknown'}` +
          (failed.length ? ` (${failed.length} skipped)` : ''),
      );
      devices.emit('recordings');
    }
    res.json({ deleted, failed });
  });

  app.get('/recordings/:filename', (req, res, next) => {
    const name = req.params.filename;
    // Whitelist + containment check; Express has already decoded %2F etc. into the param.
    if (!resolveRecordingPath(store.dir, name)) {
      res.status(400).json({ error: 'invalid recording name' });
      return;
    }
    const download = req.query.download === '1' || req.query.download === 'true';
    if (download) res.attachment(name);
    res.sendFile(
      name,
      {
        root: store.dir,
        dotfiles: 'deny',
        acceptRanges: true,
        lastModified: true,
        headers: { 'Content-Type': contentTypeFor(name), 'Cache-Control': 'no-cache' },
      },
      (err?: Error & { status?: number; statusCode?: number }) => {
        if (!err) return;
        if (res.headersSent) return;
        const status = err.status ?? err.statusCode ?? 500;
        if (status === 404) res.status(404).json({ error: 'recording not found' });
        else next(err);
      },
    );
  });

  // Always revalidate the dashboard files (cheap 304s via ETag), so browsers and
  // Cloudflare never mix a new page with an old script after an update.
  app.use(
    express.static(findPublicDir(), {
      index: 'index.html',
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
    }),
  );

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error('HTTP error', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  });

  const server = http.createServer(app);
  server.headersTimeout = 20_000;
  server.requestTimeout = 0; // long downloads/streams of big recordings are fine

  const ws = attachWebSockets(server, {
    config,
    log,
    devices,
    store,
    admin,
    serverInfo: () => ({
      version: VERSION,
      started_at: startedAt.toISOString(),
      uptime_s: uptime(),
      sample_rate: config.audio.sampleRate,
      bits: config.audio.bitsPerSample,
      channels: config.audio.channels,
      format: config.audio.format,
      audio_timeout_ms: config.audioTimeoutMs,
      storage_format: transcoder ? `mp3 ${config.mp3BitrateKbps} kbps` : 'wav',
      auth: admin ? 'login' : 'open',
    }),
  });

  let closing: Promise<void> | null = null;

  return {
    config,
    http: server,
    devices,
    store,
    ws,
    transcoder,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          resolve(server.address() as AddressInfo);
        });
      }),
    close: () =>
      (closing ??= (async () => {
        await devices.shutdown();
        if (transcoder) {
          // Give queued conversions a moment; anything unfinished is converted at the next start.
          await Promise.race([transcoder.idle(), new Promise((r) => setTimeout(r, 5000))]);
          transcoder.stop();
        }
        ws.close();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      })()),
  };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function loginPage(error: boolean, limited: boolean): string {
  const msg = limited
    ? 'Too many failed attempts. Try again in 15 minutes.'
    : error
      ? 'Wrong username or password.'
      : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in · ESP32 Mic Recorder</title>
  <link rel="stylesheet" href="/style.css?v=1.1.3">
</head>
<body class="login-body">
  <form class="login card" method="post" action="/login">
    <h1>ESP32 Mic Recorder</h1>
    <p class="muted">Sign in to view devices and recordings.</p>
    ${msg ? `<p class="warn">${escapeHtml(msg)}</p>` : ''}
    <label>Username<input name="username" autocomplete="username" required autofocus></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="btn primary" type="submit">Sign in</button>
  </form>
</body>
</html>`;
}
