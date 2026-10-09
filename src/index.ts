import { readConfig } from './config.js';
import { createLogger } from './logger.js';
import { openDatabase } from './db.js';
import { createJobs } from './jobs.js';
import { createDiscordAdapter } from './discord-adapter.js';
import { createDiscordClient, bindClient } from './client-port.js';
import { createApp } from './app.js';
import { createStatusPanel, createStatusPublisher, createStatusStore } from './status-panel.js';

let log = createLogger('info', []);
let database: ReturnType<typeof openDatabase> | undefined;
let app: ReturnType<typeof createApp> | undefined;
try {
  const config = readConfig(process.env);
  log = createLogger(config.logLevel, [config.token]);
  database = openDatabase(config.databasePath, { guildId: config.guildId, channelId: config.trapChannelId });
  const jobs = createJobs(database);
  const client = createDiscordClient();
  const statusPanel = createStatusPanel({ store: createStatusStore(database, jobs), publish: createStatusPublisher(client, config.guildId, config.trapChannelId, config.statusGifUrl), log });
  app = createApp({ config, client: bindClient(client), api: createDiscordAdapter(client), jobs, clock: { now: Date.now, random: Math.random }, log, statusPanel, closeDatabase: () => database!.close(), exit: code => process.exit(code) });
  const shutdown = () => {
    void app!.stop().then(drained => process.exit(drained ? 0 : 1)).catch(() => {
      log.emit('critical', 'shutdown_failed', { errorCode: 'SHUTDOWN_FAILURE' }); process.exit(1);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await app.start();
} catch {
  log.emit('critical', 'boot_failed', { errorCode: 'CONFIGURATION_OR_STARTUP_FAILURE' });
  if (app) {
    try { await app.stop(); } catch { /* The process exit is the final boundary. */ }
  } else if (database?.open) database.close();
  process.exit(1);
}
