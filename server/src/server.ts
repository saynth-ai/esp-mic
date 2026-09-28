import { createMicServer, VERSION } from './app.js';
import { ConfigError, configWarnings, loadConfig } from './config.js';
import { createLogger } from './logger.js';

try {
  process.loadEnvFile?.();
} catch {
  // no .env file — rely on the real environment
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[ERROR] Configuration: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const log = createLogger(config.logLevel);
  for (const w of configWarnings(config)) log.warn(w);

  const mic = await createMicServer(config, log);
  const addr = await mic.listen();
  log.info(`ESP32 mic server ${VERSION} listening on http://${addr.address}:${addr.port}`);
  log.info(`Device WebSocket: ws://<host>:${addr.port}${config.devicePath} · dashboard WebSocket: ${config.dashboardPath}`);
  log.info(`Recordings directory: ${config.recordingsDir}`);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received — finalizing recordings and shutting down`);
    const force = setTimeout(() => {
      log.error('Shutdown took too long, exiting');
      process.exit(1);
    }, 10_000);
    force.unref();
    mic
      .close()
      .then(() => {
        log.info('Shutdown complete');
        process.exit(0);
      })
      .catch((err) => {
        log.error('Error during shutdown', err);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error('Unhandled promise rejection', err));
}

main().catch((err) => {
  console.error('[ERROR] Fatal:', err);
  process.exit(1);
});
