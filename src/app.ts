import type { Config } from './config.js';
import type { StatusPanel } from './status-panel.js';
import type { Clock, DiscordPort, Jobs, Log } from './contracts.js';
import { createTrapHandler, type MessageEnvelope } from './trap-handler.js';
import { createWorker } from './softban-worker.js';
import { createScheduler } from './scheduler.js';

export interface ClientPort {
  selfId(): string;
  login(token: string): Promise<void>;
  destroy(): Promise<void>;
  onReady(fn: () => void): void;
  onMessage(fn: (message: MessageEnvelope) => void): void;
  onConnection(fn: (ready: boolean) => void): void;
  onError(fn: (error: unknown) => void): void;
}
export interface App { start(): Promise<void>; stop(): Promise<boolean> }
export function createApp(deps: {
  config: Config; client: ClientPort; api: DiscordPort; jobs: Jobs; clock: Clock; log: Log;
  closeDatabase: () => void; exit: (code: number) => void; statusPanel?: StatusPanel;
}): App {
  const { client, log } = deps;
  let handler: ReturnType<typeof createTrapHandler> | undefined;
  let stopping = false, fatal = false, initialized = false, epoch = 0;
  let startPromise: Promise<void> | undefined, stopPromise: Promise<boolean> | undefined;
  let resolveBoot: () => void = () => {}, rejectBoot: (error: unknown) => void = () => {};
  const scheduler = createScheduler({ jobs: deps.jobs, worker: createWorker({ ...deps, onFatal }), clock: deps.clock, onFatal });
  function onFatal(error: unknown): void {
    if (fatal) return;
    fatal = true; handler?.setEnabled(false); rejectBoot(error);
    log.emit('critical', 'application_fatal', { errorCode: 'DATABASE_FAILURE' });
    // Returns immediately. The currently executing worker may finish emergency cleanup.
    void stop().then(drained => { if (drained) deps.exit(1); }).catch(() => deps.exit(1));
  }
  async function ready(): Promise<void> {
    if (stopping) return;
    const current = ++epoch;
    handler?.setEnabled(false);
    if (!initialized) {
      initialized = true;
      handler = createTrapHandler({ guildId: deps.config.guildId, channelId: deps.config.trapChannelId, selfId: client.selfId(), jobs: deps.jobs, clock: deps.clock, log, wake: scheduler.wake, onFatal });
      const recoverable = deps.jobs.recoverable();
      log.emit('info', `recovery_loaded_${recoverable.length}`);
      scheduler.start();
    }
    try { await deps.api.preflight(deps.config.guildId, deps.config.trapChannelId); }
    catch (error) {
      if (stopping || current !== epoch) return;
      throw error;
    }
    if (stopping || current !== epoch) return;
    deps.statusPanel?.start();
    handler!.setEnabled(true); log.emit('info', 'ready'); resolveBoot();
  }
  async function stop(): Promise<boolean> {
    if (stopPromise) return stopPromise;
    stopping = true; ++epoch; handler?.setEnabled(false);
    rejectBoot(new Error('Application stopped'));
    stopPromise = (async () => {
      const [workerDrained, panelDrained = true] = await Promise.all([scheduler.stop(15000), deps.statusPanel?.stop(15000)]);
      const drained = workerDrained && panelDrained;
      if (!drained) log.emit('critical', 'shutdown_timeout', { errorCode: 'DRAIN_TIMEOUT' });
      try { await client.destroy(); }
      finally {
        if (drained) deps.closeDatabase();
        else deps.exit(1);
      }
      return drained;
    })();
    return stopPromise;
  }
  client.onMessage(message => handler?.handle(message));
  client.onReady(() => { void ready().catch(error => { handler?.setEnabled(false); log.emit('error', 'preflight_failed', { errorCode: 'PREFLIGHT_FAILED' }); rejectBoot(error); }); });
  client.onConnection(connected => {
    if (stopping) return;
    if (!connected) { ++epoch; handler?.setEnabled(false); log.emit('warn', 'disconnected'); }
    else void ready().catch(error => { handler?.setEnabled(false); log.emit('error', 'preflight_failed', { errorCode: 'PREFLIGHT_FAILED' }); rejectBoot(error); });
  });
  client.onError(() => { log.emit('error', 'client_error', { errorCode: 'CLIENT_ERROR' }); });
  return {
    start() {
      if (startPromise) return startPromise;
      startPromise = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const boot = new Promise<void>((resolve, reject) => { resolveBoot = resolve; rejectBoot = reject; timer = setTimeout(() => reject(new Error('Startup readiness timeout')), 30000); });
        // Attach rejection handling before invoking login, which may synchronously emit ready.
        try { await Promise.all([boot, client.login(deps.config.token)]); }
        catch (error) { await stop(); throw error; }
        finally { clearTimeout(timer); }
      })();
      return startPromise;
    },
    stop,
  };
}
