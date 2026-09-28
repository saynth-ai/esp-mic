import type { LogLevel } from './config.js';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
}

export function createLogger(level: LogLevel, sink: (line: string) => void = (l) => console.log(l)): Logger {
  const min = ORDER[level];
  const emit = (lvl: LogLevel, msg: string) => {
    if (ORDER[lvl] < min) return;
    sink(`${new Date().toISOString()} [${lvl.toUpperCase()}] ${msg}`);
  };
  return {
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m, err) => emit('error', err === undefined ? m : `${m}: ${err instanceof Error ? err.message : String(err)}`),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
