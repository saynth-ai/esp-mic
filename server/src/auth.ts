import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Pull the device token from the WebSocket upgrade request.
 * Accepted: `Authorization: Bearer <token>` or `X-Device-Token: <token>`.
 * Tokens are never accepted in the URL, where they would end up in proxy logs.
 */
export function tokenFromRequest(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1]!.trim();
  }
  const header = req.headers['x-device-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return null;
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time comparison against every accepted token. */
export function isValidDeviceToken(token: string | null, accepted: readonly string[]): boolean {
  if (!token) return false;
  const given = digest(token);
  let ok = false;
  for (const t of accepted) ok = timingSafeEqual(given, digest(t)) || ok;
  return ok;
}
