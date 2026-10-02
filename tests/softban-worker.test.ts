import { expect, it } from 'vitest';
import { ApiFailure } from '../src/contracts.js';
import { retryDelay } from '../src/softban-worker.js';
import { fixture } from './helpers.js';

it('bans and unbans without waiting, allows a later new message', async () => {
  const f = fixture();
  try {
    const job = f.enqueue(); await f.makeWorker().run(job);
    expect(f.calls).toEqual(['ban', 'unban']);
    expect(f.jobs.get(job.id).state).toBe('completed');
    expect(f.remote.has('u')).toBe(false);
    expect(f.clock.now()).toBe(1000);
    expect(f.jobs.accept({ guildId: 'g', channelId: 'c', userId: 'u', messageId: 'm' }, 1000).kind).toBe('duplicate');
    expect(f.enqueue('m2').id).not.toBe(job.id);
  } finally { f.close(); }
});
it('preserves unban retries through 100 failures and never re-bans', async () => {
  const f = fixture();
  try {
    f.api.unban.mockRejectedValue(new ApiFailure('transient', 'ETIMEDOUT'));
    const job = f.enqueue(), worker = f.makeWorker();
    for (let i = 1; i <= 100; i++) {
      await worker.run(f.jobs.get(job.id));
      const row = f.jobs.get(job.id);
      expect(row.state).toBe('unbanning'); expect(row.attempts).toBe(i);
      f.advance(row.nextAttemptAt - f.clock.now());
    }
    expect(f.api.ban).toHaveBeenCalledOnce();
    f.api.unban.mockImplementation(async (_g, u) => { f.remote.delete(u); });
    await worker.run(f.jobs.get(job.id));
    expect(f.jobs.get(job.id).state).toBe('completed');
  } finally { f.close(); }
});
it('rejects pre-existing bans without unbanning', async () => {
  const f = fixture();
  try {
    const job = f.enqueue(); f.remote.set('u', { reason: 'admin' });
    await f.makeWorker().run(job);
    expect(f.jobs.get(job.id)).toMatchObject({ state: 'failed', lastError: 'PREEXISTING_BAN' });
    expect(f.calls).toEqual([]);
  } finally { f.close(); }
});
it.each(['OWNER', 'HIERARCHY', '50013'])('fails permission check %s without destructive calls', async code => {
  const f = fixture();
  try {
    const job = f.enqueue(); f.api.canBan.mockRejectedValue(new ApiFailure('permanent', code));
    await f.makeWorker().run(job);
    expect(f.jobs.get(job.id)).toMatchObject({ state: 'failed', lastError: code }); expect(f.calls).toEqual([]);
  } finally { f.close(); }
});
it('parks queued API failures for retry before any ban', async () => {
  const f = fixture();
  try {
    const job = f.enqueue(); f.api.getBan.mockRejectedValueOnce(new ApiFailure('transient', 'ETIMEDOUT'));
    await f.makeWorker().run(job);
    expect(f.jobs.get(job.id)).toMatchObject({ state: 'queued', attempts: 1, nextAttemptAt: 2000 });
    await f.makeWorker().run(job); expect(f.calls).toEqual([]);
  } finally { f.close(); }
});
it.each([null, 'admin'])('never unbans a mismatched reason %s', async reason => {
  const f = fixture();
  try {
    const job = f.enqueue(); f.jobs.change(job.id, 'queued', { state: 'banning', banStartedAt: 1000 }, 1000);
    f.remote.set('u', { reason }); await f.makeWorker().run(job);
    expect(f.jobs.get(job.id).state).toBe('manual_review'); expect(f.calls).toEqual([]);
  } finally { f.close(); }
});
it('reconciles an ambiguous successful ban instead of repeating it', async () => {
  const f = fixture();
  try {
    const job = f.enqueue();
    f.api.ban.mockImplementationOnce(async (_g, u, reason) => { f.remote.set(u, { reason }); throw new ApiFailure('transient', 'ETIMEDOUT'); });
    await f.makeWorker().run(job);
    expect(f.api.ban).toHaveBeenCalledOnce(); expect(f.api.unban).toHaveBeenCalledOnce();
    expect(f.jobs.get(job.id).state).toBe('completed');
  } finally { f.close(); }
});
it('unknown ban error with absent ban requires review, not a blind retry', async () => {
  const f = fixture();
  try {
    const job = f.enqueue(); f.api.ban.mockRejectedValue(new ApiFailure('permanent', 'UNCLASSIFIED_API_ERROR'));
    await f.makeWorker().run(job);
    expect(f.jobs.get(job.id)).toMatchObject({ state: 'manual_review', lastError: 'AMBIGUOUS_BAN_ABSENT' });
    await f.makeWorker().run(job); expect(f.api.ban).toHaveBeenCalledOnce(); expect(f.api.unban).not.toHaveBeenCalled();
  } finally { f.close(); }
});
it('definitive ban rejection fails, while permanent unban failure requires review', async () => {
  const f = fixture();
  try {
    const job = f.enqueue(); f.api.ban.mockRejectedValueOnce(new ApiFailure('permanent', '50013'));
    await f.makeWorker().run(job); expect(f.jobs.get(job.id).state).toBe('failed');
    const next = f.enqueue('m2'); f.api.unban.mockRejectedValueOnce(new ApiFailure('permanent', '50013'));
    await f.makeWorker().run(next); expect(f.jobs.get(next.id).state).toBe('manual_review');
    expect(f.remote.has('u')).toBe(true);
  } finally { f.close(); }
});
it('throttles unresolved alerts across restart', () => {
  const f = fixture();
  try {
    const job = f.enqueue(); f.jobs.change(job.id, 'queued', { state: 'banning', banStartedAt: 1000 }, 1000);
    f.advance(60000); f.makeWorker().checkAlerts();
    expect(f.jobs.get(job.id).lastAlertAt).toBe(61000);
    f.reopen(); f.makeWorker().checkAlerts(); expect(f.log.emit).toHaveBeenCalledTimes(1);
    f.advance(300000); f.makeWorker().checkAlerts(); expect(f.log.emit).toHaveBeenCalledTimes(2);
  } finally { f.close(); }
});
it.each(['banning', 'unbanning'] as const)('persists transient recovery lookup failures in %s', async phase => {
  const f = fixture();
  try {
    const job = f.enqueue(); f.jobs.change(job.id, 'queued', { state: 'banning', banStartedAt: 1000 }, 1000);
    if (phase === 'unbanning') f.jobs.change(job.id, 'banning', { state: phase }, 1000);
    f.api.getBan.mockRejectedValueOnce(new ApiFailure('transient', 'HTTP_503'));
    await f.makeWorker().run(job);
    expect(f.jobs.get(job.id)).toMatchObject({ state: phase, attempts: 1, nextAttemptAt: 2000 });
    expect(f.calls).toEqual([]);
  } finally { f.close(); }
});
it('fresh ownership check protects an administrator replacement after a successful ban', async () => {
  const f = fixture();
  try {
    const job = f.enqueue();
    f.api.ban.mockImplementationOnce(async (_g, u) => { f.remote.set(u, { reason: 'admin' }); });
    await f.makeWorker().run(job);
    expect(f.jobs.get(job.id).state).toBe('manual_review'); expect(f.api.unban).not.toHaveBeenCalled();
    expect(f.remote.get('u')?.reason).toBe('admin');
  } finally { f.close(); }
});

it('caps exponential jitter', () => {
  expect(retryDelay(1, 0)).toBe(1000); expect(retryDelay(2, 0)).toBe(2000);
  expect(retryDelay(30, 1)).toBe(60000); expect(retryDelay(1, 1)).toBe(1200);
});
