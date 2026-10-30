import { config } from './config.js';
import { app } from './app.js';
import { closeDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';

async function main() {
  if (config.AUTO_MIGRATE) {
    await migrate();
  }
  if (config.SCHEDULER_ENABLED) {
    startScheduler();
  }

  const server = app.listen(config.PORT, () => {
    console.log(`My Life AI server listening on http://localhost:${config.PORT}`);
    console.log(
      `AI: ${config.aiEnabled ? 'configured' : 'rule-based only'} | Places: ${
        config.placesEnabled ? 'configured' : 'not configured'
      } | Push: ${config.EXPO_ACCESS_TOKEN ? 'configured' : 'local only'}`,
    );
  });

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    stopScheduler();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (error) => {
  console.error('Server failed to start:', error);
  await closeDb().catch(() => {});
  process.exit(1);
});
