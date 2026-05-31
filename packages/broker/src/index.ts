import { loadConfig } from './config.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const server = await startServer(config);
  // eslint-disable-next-line no-console
  console.log(`[claude-browser-broker] listening on ws://${server.host}:${server.port}`);

  const shutdown = (signal: string): void => {
    // eslint-disable-next-line no-console
    console.log(`[claude-browser-broker] ${signal} received, shutting down`);
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[claude-browser-broker] fatal:', err);
  process.exit(1);
});
