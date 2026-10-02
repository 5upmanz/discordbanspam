import type { Clock, Jobs, Scheduler, Worker } from './contracts.js';

export function createScheduler(deps: { jobs: Jobs; worker: Worker; clock: Clock; onFatal: (error: unknown) => void }): Scheduler {
  let stopped = true, started = false, wakeRequested = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let draining: Promise<void> | undefined;
  function wake(): void {
    if (stopped) return;
    if (draining) { wakeRequested = true; return; }
    // Start on a microtask so the drain promise is assigned before callbacks can stop it.
    draining = Promise.resolve().then(async () => {
      try {
        do {
          wakeRequested = false;
          if (stopped) break;
          deps.worker.checkAlerts();
          while (!stopped) {
            const job = deps.jobs.nextDue(deps.clock.now());
            if (!job) break;
            await deps.worker.run(job);
          }
        } while (wakeRequested && !stopped);
      } catch (error) {
        stopped = true;
        clearInterval(interval);
        deps.onFatal(error);
      }
    }).finally(() => { draining = undefined; });
  }
  return {
    start() { if (started) return; started = true; stopped = false; interval = setInterval(wake, 1000); wake(); },
    wake,
    async stop(timeoutMs) {
      stopped = true; clearInterval(interval);
      if (!draining) return true;
      const pending = draining;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          pending.then(() => true),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
      } finally { clearTimeout(timer); }
    },
  };
}
