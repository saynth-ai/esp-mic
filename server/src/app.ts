import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Config } from './config.js';
import { corsMiddleware } from './cors.js';
import { DeviceManager } from './devices.js';
import type { Logger } from './logger.js';
import { contentTypeFor, RecordingStore, resolveRecordingPath } from './recordings.js';
import { Mp3Transcoder } from './transcoder.js';
import { attachWebSockets, type WebSocketLayer } from './websocket.js';

export const VERSION = '1.0.0';

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

  app.use(express.static(findPublicDir(), { index: 'index.html', maxAge: '5m' }));

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
