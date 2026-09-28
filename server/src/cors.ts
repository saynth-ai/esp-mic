import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from 'express';
import type { Config } from './config.js';

/** Same-origin requests are always allowed; others only if listed in CORS_ORIGINS. */
export function isOriginAllowed(origin: string | undefined, host: string | undefined, config: Config): boolean {
  if (!origin) return true; // not a browser cross-origin request
  if (config.corsOrigins === '*') return true;
  if (config.corsOrigins.includes(origin)) return true;
  try {
    return host !== undefined && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function originOf(req: IncomingMessage): string | undefined {
  const o = req.headers.origin;
  return typeof o === 'string' ? o : undefined;
}

export function corsMiddleware(config: Config): RequestHandler {
  return (req, res, next) => {
    const origin = originOf(req);
    if (origin && isOriginAllowed(origin, req.headers.host, config)) {
      res.setHeader('Access-Control-Allow-Origin', config.corsOrigins === '*' ? '*' : origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(origin && isOriginAllowed(origin, req.headers.host, config) ? 204 : 403);
      return;
    }
    next();
  };
}
