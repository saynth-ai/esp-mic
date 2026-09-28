import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Single fixed admin account (ADMIN_USER / ADMIN_PASSWORD from the environment)
 * with a stateless signed session cookie:
 *
 *   mic_session = <expiresMs>.<hex HMAC-SHA256(key, expiresMs)>
 *
 * The HMAC key is derived from the password (and SESSION_SECRET), so sessions
 * survive restarts and are all invalidated when the password changes.
 */

export const SESSION_COOKIE = 'mic_session';

export interface AdminOptions {
  user: string;
  password: string;
  sessionSecret: string;
  sessionTtlMs: number;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export class AdminAuth {
  private readonly key: Buffer;

  constructor(private readonly opts: AdminOptions) {
    this.key = createHmac('sha256', opts.sessionSecret || 'esp32-mic').update(`admin:${opts.user}:${opts.password}`).digest();
  }

  get ttlMs(): number {
    return this.opts.sessionTtlMs;
  }

  checkCredentials(user: string, password: string): boolean {
    // Evaluate both so timing doesn't reveal which one was wrong.
    const u = safeEqual(user, this.opts.user);
    const p = safeEqual(password, this.opts.password);
    return u && p;
  }

  issue(now = Date.now()): string {
    const expires = String(now + this.opts.sessionTtlMs);
    return `${expires}.${this.sign(expires)}`;
  }

  verify(token: string | undefined, now = Date.now()): boolean {
    if (!token) return false;
    const dot = token.indexOf('.');
    if (dot <= 0) return false;
    const expires = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!/^\d{1,16}$/.test(expires) || Number(expires) < now) return false;
    return safeEqual(sig, this.sign(expires));
  }

  /** Session check for raw HTTP requests (WebSocket upgrades). */
  verifyRequest(req: IncomingMessage): boolean {
    return this.verify(readCookie(req.headers.cookie, SESSION_COOKIE));
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('hex');
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Fixed-window limiter for failed logins, per client address. */
export class LoginLimiter {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  blocked(key: string, now = Date.now()): boolean {
    const f = this.failures.get(key);
    if (!f || f.resetAt <= now) return false;
    return f.count >= this.maxFailures;
  }

  fail(key: string, now = Date.now()): void {
    const f = this.failures.get(key);
    if (!f || f.resetAt <= now) this.failures.set(key, { count: 1, resetAt: now + this.windowMs });
    else f.count++;
    if (this.failures.size > 10_000) {
      for (const [k, v] of this.failures) if (v.resetAt <= now) this.failures.delete(k);
    }
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }
}
