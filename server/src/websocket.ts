import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { ADPCM_FORMAT, decodeAdpcmBlock } from './adpcm.js';
import type { AdminAuth } from './admin.js';
import { isValidDeviceToken, tokenFromRequest } from './auth.js';
import type { Config } from './config.js';
import { isOriginAllowed, originOf } from './cors.js';
import type { DeviceConnection, DeviceManager, DeviceSession } from './devices.js';
import type { Logger } from './logger.js';
import { checkHelloFormat, CloseCode, DEVICE_ID_PATTERN, parseControlMessage, PROTOCOL_VERSION, ProtocolError } from './protocol.js';
import type { RecordingStore } from './recordings.js';

/** Recordings pushed to dashboards per update; the REST API has the full list. */
const DASHBOARD_RECORDINGS_LIMIT = 200;
/** Skip dashboard clients this far behind rather than buffering without bound. */
const DASHBOARD_MAX_BUFFERED = 1024 * 1024;
/** Live listeners further behind than this (~2 s of audio) lose frames instead of lagging. */
const LIVE_MAX_BUFFERED = 64 * 1024;

export interface WebSocketDeps {
  config: Config;
  log: Logger;
  devices: DeviceManager;
  store: RecordingStore;
  /** Dashboard login; null = open. */
  admin: AdminAuth | null;
  serverInfo: () => object;
}

export interface WebSocketLayer {
  dashboardClients(): number;
  liveListeners(): number;
  close(): void;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function describeClose(code: number, reason: Buffer): string {
  const r = reason.toString('utf8');
  const base =
    code === 1000 ? 'closed normally' : code === 1001 ? 'going away' : code === 1006 ? 'connection lost' : `close code ${code}`;
  return r ? `${base}: ${r}` : base;
}

export function remoteAddress(req: IncomingMessage, trustProxy: boolean): string | null {
  let raw: string | null = req.socket.remoteAddress ?? null;
  if (trustProxy) {
    // Cloudflare's own header can't be supplied by the client; X-Forwarded-For's
    // first entry can, so it is only the fallback.
    const cf = req.headers['cf-connecting-ip'];
    const fwd = req.headers['x-forwarded-for'];
    if (typeof cf === 'string' && cf.trim()) raw = cf.trim();
    else if (typeof fwd === 'string' && fwd.trim()) raw = fwd.split(',')[0]!.trim();
  }
  return raw?.startsWith('::ffff:') ? raw.slice(7) : raw;
}

export function attachWebSockets(server: Server, deps: WebSocketDeps): WebSocketLayer {
  const { config, log, devices, store } = deps;
  const deviceWss = new WebSocketServer({ noServer: true, maxPayload: config.maxFrameBytes, perMessageDeflate: false });
  const dashWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  const dashboards = new Set<WebSocket>();
  const liveWss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  /** device_id → browsers listening to its live audio */
  const listeners = new Map<string, Set<WebSocket>>();

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return rejectUpgrade(socket, 400, 'Bad Request');
    }

    if (pathname === config.devicePath) {
      // Devices authenticate with their token, never with the dashboard login.
      if (!isValidDeviceToken(tokenFromRequest(req), config.deviceTokens)) {
        log.warn(`Rejected device connection from ${remoteAddress(req, config.trustProxy)}: invalid or missing token`);
        return rejectUpgrade(socket, 401, 'Unauthorized');
      }
      deviceWss.handleUpgrade(req, socket, head, (ws) => onDevice(ws, req));
      return;
    }

    if (pathname !== config.dashboardPath && pathname !== config.livePath) return rejectUpgrade(socket, 404, 'Not Found');
    if (deps.admin && !deps.admin.verifyRequest(req)) return rejectUpgrade(socket, 401, 'Unauthorized');
    if (!isOriginAllowed(originOf(req), req.headers.host, config)) {
      log.warn(`Rejected browser WebSocket from origin ${originOf(req)}`);
      return rejectUpgrade(socket, 403, 'Forbidden');
    }

    if (pathname === config.dashboardPath) {
      dashWss.handleUpgrade(req, socket, head, (ws) => onDashboard(ws));
    } else {
      const deviceId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('device') ?? '';
      if (!DEVICE_ID_PATTERN.test(deviceId)) return rejectUpgrade(socket, 400, 'Bad Request');
      liveWss.handleUpgrade(req, socket, head, (ws) => onLiveListener(ws, deviceId));
    }
  });

  // ---------------------------------------------------------------- devices

  function onDevice(ws: WebSocket, req: IncomingMessage): void {
    const remote = remoteAddress(req, config.trustProxy);
    let session: DeviceSession | null = null;
    /** Set for ADPCM devices: samples per block. */
    let adpcmSamples = 0;
    let alive = true;
    const label = () => session?.deviceId ?? remote ?? 'unknown device';

    const conn: DeviceConnection = {
      send(msg) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
      close(code, reason) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason.slice(0, 120));
        // Don't wait forever for a dead peer to complete the closing handshake.
        setTimeout(() => ws.terminate(), 2000).unref();
      },
    };

    const fail = (err: ProtocolError) => {
      log.warn(`Device ${label()}: ${err.message}`);
      conn.send({ type: 'error', message: err.message });
      conn.close(err.closeCode, err.message);
    };

    const helloTimer = setTimeout(
      () => fail(new ProtocolError(`no hello within ${config.helloTimeoutMs} ms`, CloseCode.HelloTimeout)),
      config.helloTimeoutMs,
    );

    const heartbeat = setInterval(() => {
      if (!alive) {
        log.warn(`WebSocket timeout: ${label()} missed a heartbeat, dropping connection`);
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, config.pingIntervalMs);

    ws.on('pong', () => (alive = true));

    ws.on('message', (data, isBinary) => {
      alive = true;
      const buf = toBuffer(data);

      // Binary frames are PCM, full stop. They are never decoded as text.
      if (isBinary) {
        if (!session) return fail(new ProtocolError('audio received before hello'));
        if (adpcmSamples) {
          const pcm = decodeAdpcmBlock(buf, adpcmSamples);
          if (pcm) session.audio(pcm, buf.length);
          else session.invalidFrame(buf.length);
        } else {
          session.audio(buf, buf.length);
        }
        return;
      }

      let msg;
      try {
        msg = parseControlMessage(buf);
      } catch (err) {
        const pe = err instanceof ProtocolError ? err : new ProtocolError(String(err));
        if (!session) return fail(pe);
        log.warn(`Device ${label()}: ignored bad control message (${pe.message})`);
        conn.send({ type: 'error', message: pe.message });
        return;
      }

      if (msg.type === 'hello') {
        if (session) {
          conn.send({ type: 'error', message: 'duplicate hello ignored' });
          return;
        }
        try {
          checkHelloFormat(msg, config.audio);
        } catch (err) {
          return fail(err as ProtocolError);
        }
        clearTimeout(helloTimer);
        adpcmSamples = msg.format === ADPCM_FORMAT ? msg.frame_samples! : 0;
        session = deps.devices.connect(msg, conn, remote);
        conn.send({
          type: 'welcome',
          protocol: PROTOCOL_VERSION,
          device_id: msg.device_id,
          sample_rate: config.audio.sampleRate,
          audio_timeout_ms: config.audioTimeoutMs,
          max_frame_bytes: config.maxFrameBytes,
          server_time: new Date().toISOString(),
        });
        return;
      }

      if (!session) return fail(new ProtocolError(`"${msg.type}" received before hello`));
      switch (msg.type) {
        case 'start':
          session.start();
          break;
        case 'stop':
          session.stop();
          break;
        case 'telemetry':
          session.telemetry(msg);
          break;
        case 'ping':
          conn.send({ type: 'pong', server_time: new Date().toISOString() });
          break;
      }
    });

    ws.on('close', (code, reason) => {
      clearTimeout(helloTimer);
      clearInterval(heartbeat);
      session?.closed(describeClose(code, reason));
    });

    ws.on('error', (err) => log.warn(`Device socket error (${label()}): ${err.message}`));
  }

  // ------------------------------------------------------------ live audio

  // Every validated PCM frame is forwarded as-is (binary, s16le mono) to that device's listeners.
  const onAudio = (deviceId: string, pcm: Buffer) => {
    const set = listeners.get(deviceId);
    if (!set) return;
    for (const c of set) {
      if (c.readyState === WebSocket.OPEN && c.bufferedAmount < LIVE_MAX_BUFFERED) c.send(pcm, { binary: true });
    }
  };
  devices.on('audio', onAudio);

  function onLiveListener(ws: WebSocket, deviceId: string): void {
    let set = listeners.get(deviceId);
    if (!set) listeners.set(deviceId, (set = new Set()));
    set.add(ws);
    log.info(`Live listener attached to ${deviceId} (${set.size} listening)`);
    ws.send(
      JSON.stringify({
        type: 'live',
        device_id: deviceId,
        sample_rate: config.audio.sampleRate,
        format: config.audio.format,
        channels: config.audio.channels,
      }),
    );
    const detach = () => {
      if (!set!.delete(ws)) return;
      if (set!.size === 0) listeners.delete(deviceId);
      log.info(`Live listener left ${deviceId}`);
    };
    ws.on('close', detach);
    ws.on('error', detach);
    ws.on('message', () => {
      /* receive-only */
    });
  }

  // ------------------------------------------------------------- dashboards

  const broadcast = (msg: object) => {
    if (dashboards.size === 0) return;
    const text = JSON.stringify(msg);
    for (const c of dashboards) {
      if (c.readyState === WebSocket.OPEN && c.bufferedAmount < DASHBOARD_MAX_BUFFERED) c.send(text);
    }
  };

  const recordingsMessage = async () => {
    const list = await store.list();
    return {
      type: 'recordings',
      recordings: list.slice(0, DASHBOARD_RECORDINGS_LIMIT),
      total: list.length,
      storage: await store.stats(list),
    };
  };

  let recordingsTimer: NodeJS.Timeout | null = null;
  const scheduleRecordingsPush = () => {
    if (recordingsTimer || dashboards.size === 0) return;
    recordingsTimer = setTimeout(() => {
      recordingsTimer = null;
      recordingsMessage()
        .then(broadcast)
        .catch((err) => log.error('Could not list recordings', err));
    }, 150);
  };

  const onStatus = (status: object) => broadcast(status);
  devices.on('status', onStatus);
  devices.on('recordings', scheduleRecordingsPush);

  const dashHeartbeat = setInterval(() => {
    for (const c of dashboards) {
      const tagged = c as WebSocket & { alive?: boolean };
      if (tagged.alive === false) {
        c.terminate();
        continue;
      }
      tagged.alive = false;
      c.ping();
    }
  }, 30_000);
  dashHeartbeat.unref();

  function onDashboard(ws: WebSocket): void {
    dashboards.add(ws);
    const tagged = ws as WebSocket & { alive?: boolean };
    tagged.alive = true;
    ws.on('pong', () => (tagged.alive = true));
    ws.on('close', () => dashboards.delete(ws));
    ws.on('error', () => dashboards.delete(ws));
    ws.on('message', () => {
      /* dashboards are receive-only */
    });

    recordingsMessage()
      .then((rec) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(
          JSON.stringify({ ...rec, type: 'snapshot', server: deps.serverInfo(), devices: devices.list() }),
        );
      })
      .catch((err) => log.error('Could not build dashboard snapshot', err));
  }

  return {
    dashboardClients: () => dashboards.size,
    liveListeners: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    close() {
      devices.off('status', onStatus);
      devices.off('recordings', scheduleRecordingsPush);
      devices.off('audio', onAudio);
      clearInterval(dashHeartbeat);
      if (recordingsTimer) clearTimeout(recordingsTimer);
      for (const c of dashboards) c.terminate();
      for (const c of deviceWss.clients) c.terminate();
      for (const c of liveWss.clients) c.terminate();
      liveWss.close();
      deviceWss.close();
      dashWss.close();
    },
  };
}
