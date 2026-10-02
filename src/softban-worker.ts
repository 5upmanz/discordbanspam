import { ApiFailure, type Clock, type DiscordPort, type Job, type Jobs, type Log, type LogFields, type Worker } from './contracts.js';

export function retryDelay(attempt: number, random: number): number {
  const base = Math.min(60000, 1000 * 2 ** Math.min(16, Math.max(0, attempt - 1)));
  return Math.min(60000, Math.round(base * (1 + Math.max(0, Math.min(1, random)) * 0.2)));
}
const definitiveRejections = new Set(['50001', '50013', '50035', '10007', '10013', 'HTTP_400', 'HTTP_401', 'HTTP_403', 'HTTP_404']);
// Only API operations go inside this catch. Repository errors must reach the fatal path.
async function request<T>(operation: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: ApiFailure }> {
  try { return { ok: true, value: await operation() }; }
  catch (error) { return { ok: false, error: error instanceof ApiFailure ? error : new ApiFailure('permanent', 'UNCLASSIFIED_API_ERROR') }; }
}
function fields(job: Job): LogFields {
  return { jobId: job.id, guildId: job.guildId, channelId: job.channelId, userId: job.userId, state: job.state };
}
export function createWorker(deps: { jobs: Jobs; api: DiscordPort; clock: Clock; log: Log; onFatal: (error: unknown) => void }): Worker {
  const { jobs, api, clock, log } = deps;
  function failure(job: Job, error: ApiFailure): Job {
    if (error.kind === 'transient') {
      const attempts = job.attempts + 1, nextAttemptAt = clock.now() + retryDelay(attempts, clock.random());
      const updated = jobs.change(job.id, job.state, { attempts, nextAttemptAt, lastError: error.code }, clock.now());
      log.emit('warn', 'job_retry', { ...fields(updated), errorCode: error.code, retryAt: nextAttemptAt });
      return updated;
    }
    return finish(job, job.state === 'queued' ? 'failed' : 'manual_review', error.code);
  }
  function finish(job: Job, state: 'completed' | 'failed' | 'manual_review', code: string | null, ownership = job.ownership): Job {
    const updated = jobs.change(job.id, job.state, { state, ownership, lastError: code, ...(state === 'completed' ? { attempts: 0 } : {}) }, clock.now());
    log.emit(state === 'completed' ? 'info' : 'error', `job_${state}`, { ...fields(updated), ...(code ? { errorCode: code } : {}) });
    return updated;
  }
  async function emergency(job: Job): Promise<void> {
    // No cancellation is claimed. The lifecycle keeps the drain pending and terminates
    // after 15s if the in-flight call never settles. A late lookup cannot start unban.
    const deadline = Date.now() + 10000;
    const lookup = await request(() => api.getBan(job.guildId, job.userId));
    if (Date.now() >= deadline || !lookup.ok || lookup.value?.reason !== job.reason) return;
    await request(() => api.unban(job.guildId, job.userId, job.reason));
  }
  return {
    async run(input) {
      let job = input, ownedBanMayExist = false;
      try {
        job = jobs.get(input.id);
        if (!['queued', 'banning', 'unbanning'].includes(job.state) || job.nextAttemptAt > clock.now()) return;
        if (job.state === 'queued') {
          const lookup = await request(() => api.getBan(job.guildId, job.userId));
          if (!lookup.ok) { failure(job, lookup.error); return; }
          if (lookup.value) { finish(job, 'failed', 'PREEXISTING_BAN', 'foreign'); return; }
          const allowed = await request(() => api.canBan(job.guildId, job.userId));
          if (!allowed.ok) { failure(job, allowed.error); return; }
          job = jobs.change(job.id, 'queued', { state: 'banning', banStartedAt: clock.now(), attempts: 0, nextAttemptAt: clock.now() }, clock.now());
          const ban = await request(() => api.ban(job.guildId, job.userId, job.reason));
          if (ban.ok) {
            ownedBanMayExist = true;
            job = jobs.change(job.id, 'banning', { state: 'unbanning', attempts: 0, nextAttemptAt: clock.now() }, clock.now());
          } else if (ban.error.kind === 'permanent' && definitiveRejections.has(ban.error.code)) {
            finish(job, 'failed', ban.error.code); return;
          }
          // Ambiguous dispatch stays banning and is reconciled below, never dispatched again.
        }
        if (job.state === 'banning') {
          const lookup = await request(() => api.getBan(job.guildId, job.userId));
          if (!lookup.ok) { failure(job, lookup.error); return; }
          if (!lookup.value) { finish(job, 'manual_review', 'AMBIGUOUS_BAN_ABSENT', 'absent'); return; }
          if (lookup.value.reason !== job.reason) {
            finish(job, 'manual_review', 'BAN_OWNERSHIP_MISMATCH', lookup.value.reason === null ? 'unknown' : 'foreign'); return;
          }
          ownedBanMayExist = true;
          job = jobs.change(job.id, 'banning', { state: 'unbanning', ownership: 'matched', attempts: 0, nextAttemptAt: clock.now() }, clock.now());
        }
        if (job.state === 'unbanning') {
          const lookup = await request(() => api.getBan(job.guildId, job.userId));
          if (!lookup.ok) { failure(job, lookup.error); return; }
          if (!lookup.value) { finish(job, 'completed', null, 'absent'); return; }
          if (lookup.value.reason !== job.reason) {
            finish(job, 'manual_review', 'BAN_OWNERSHIP_MISMATCH', lookup.value.reason === null ? 'unknown' : 'foreign'); return;
          }
          ownedBanMayExist = true;
          job = jobs.change(job.id, 'unbanning', { ownership: 'matched' }, clock.now());
          const unban = await request(() => api.unban(job.guildId, job.userId, job.reason));
          if (!unban.ok) { failure(job, unban.error); return; }
          finish(job, 'completed', null, 'absent');
        }
      } catch (error) {
        deps.onFatal(error);
        log.emit('critical', 'worker_storage_failure', { ...fields(job), errorCode: 'DATABASE_FAILURE' });
        if (ownedBanMayExist) await emergency(job);
      }
    },
    checkAlerts() {
      try {
        for (const job of jobs.overdue(clock.now())) {
          log.emit('error', 'softban_unresolved', { ...fields(job), ...(job.lastError ? { errorCode: job.lastError } : {}) });
          jobs.change(job.id, job.state, { lastAlertAt: clock.now() }, clock.now());
        }
      } catch (error) { deps.onFatal(error); }
    },
  };
}
