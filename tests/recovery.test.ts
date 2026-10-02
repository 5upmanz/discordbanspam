import { expect, it, vi } from 'vitest';
import { ApiFailure, type JobPatch, type State } from '../src/contracts.js';
import { fixture } from './helpers.js';

it('empty recovery does nothing before a queue commit', () => {
  const f = fixture(); try { f.reopen(); expect(f.jobs.recoverable()).toEqual([]); expect(f.calls).toEqual([]); } finally { f.close(); }
});
it('runs a committed queue after restart', async () => {
  const f = fixture(); try { const job = f.enqueue(); f.reopen(); await f.makeWorker().run(job); expect(f.calls).toEqual(['ban','unban']); expect(f.jobs.get(job.id).state).toBe('completed'); } finally { f.close(); }
});
it.each(['banning', 'unbanning'] as const)('recovers an owned ban in %s without re-banning', async phase => {
  const f = fixture();
  try {
    const job = f.enqueue(); f.jobs.change(job.id, 'queued', { state: 'banning', banStartedAt: 1000 }, 1000);
    if (phase === 'unbanning') f.jobs.change(job.id, 'banning', { state: 'unbanning' }, 1000);
    f.remote.set('u', { reason: job.reason }); f.reopen(); await f.makeWorker().run(job);
    expect(f.api.ban).not.toHaveBeenCalled(); expect(f.api.unban).toHaveBeenCalledOnce();
    expect(f.jobs.get(job.id).state).toBe('completed');
  } finally { f.close(); }
});
it('lost unban acknowledgement completes after restart without API effects', async () => {
  const f = fixture();
  try {
    const job = f.enqueue(); f.jobs.change(job.id, 'queued', { state: 'banning', banStartedAt: 1000 }, 1000);
    f.jobs.change(job.id, 'banning', { state: 'unbanning' }, 1000);
    f.reopen(); await f.makeWorker().run(job); expect(f.calls).toEqual([]); expect(f.jobs.get(job.id).state).toBe('completed');
    f.reopen(); await f.makeWorker().run(job); expect(f.calls).toEqual([]);
  } finally { f.close(); }
});
it('banning intent before HTTP with absent ban requires review', async () => {
  const f = fixture();
  try {
    const job = f.enqueue(); f.jobs.change(job.id, 'queued', { state: 'banning', banStartedAt: 1000 }, 1000);
    f.reopen(); await f.makeWorker().run(job); expect(f.jobs.get(job.id).state).toBe('manual_review'); expect(f.calls).toEqual([]);
  } finally { f.close(); }
});
it.each(['banning', 'unbanning'] as const)('leaves an administrator replacement untouched during %s recovery', async phase => {
  const f = fixture();
  try {
    const job = f.enqueue(); f.jobs.change(job.id, 'queued', { state: 'banning', banStartedAt: 1000 }, 1000);
    if (phase === 'unbanning') f.jobs.change(job.id, 'banning', { state: phase }, 1000);
    f.remote.set('u', { reason: 'admin' }); f.reopen(); await f.makeWorker().run(job);
    expect(f.jobs.get(job.id).state).toBe('manual_review'); expect(f.remote.get('u')?.reason).toBe('admin'); expect(f.calls).toEqual([]);
  } finally { f.close(); }
});
it('permission loss on recovery requires review, not unban', async () => {
  const f = fixture();
  try {
    const job = f.enqueue(); f.jobs.change(job.id, 'queued', { state: 'banning', banStartedAt: 1000 }, 1000);
    f.reopen(); f.api.getBan.mockRejectedValue(new ApiFailure('permanent', '50013'));
    await f.makeWorker().run(job); expect(f.jobs.get(job.id).state).toBe('manual_review'); expect(f.calls).toEqual([]);
  } finally { f.close(); }
});
function failTransition(f: ReturnType<typeof fixture>, from: State, to: State) {
  const original = f.jobs.change.bind(f.jobs);
  vi.spyOn(f.jobs, 'change').mockImplementation((id, expected, patch: JobPatch, now) => {
    if (expected === from && patch.state === to) throw new Error('disk full');
    return original(id, expected, patch, now);
  });
}
it('pre-ban persist failure sends no destructive request', async () => {
  const f = fixture();
  try {
    const job = f.enqueue(); failTransition(f, 'queued', 'banning'); await f.makeWorker().run(job);
    expect(f.onFatal).toHaveBeenCalledOnce(); expect(f.calls).toEqual([]); expect(f.jobs.get(job.id).state).toBe('queued');
  } finally { f.close(); }
});
it('post-ban persist failure attempts owned emergency unban then recovers durable state', async () => {
  const f = fixture();
  try {
    const job = f.enqueue(); failTransition(f, 'banning', 'unbanning'); await f.makeWorker().run(job);
    expect(f.onFatal).toHaveBeenCalledOnce(); expect(f.calls).toEqual(['ban','unban']);
    expect(f.jobs.get(job.id).state).toBe('banning');
    expect(f.log.emit).toHaveBeenCalledWith('critical', 'worker_storage_failure', expect.anything());
    f.reopen(); await f.makeWorker().run(job); expect(f.jobs.get(job.id).state).toBe('manual_review');
  } finally { f.close(); }
});
it('failure before completed commit is recovered as absent without re-ban', async () => {
  const f = fixture();
  try {
    const job = f.enqueue(); failTransition(f, 'unbanning', 'completed'); await f.makeWorker().run(job);
    expect(f.jobs.get(job.id).state).toBe('unbanning'); expect(f.onFatal).toHaveBeenCalledOnce();
    f.reopen(); await f.makeWorker().run(job); expect(f.jobs.get(job.id).state).toBe('completed'); expect(f.api.ban).toHaveBeenCalledOnce();
  } finally { f.close(); }
});
it('emergency lookup mismatch never unbans', async () => {
  const f = fixture();
  try {
    const job = f.enqueue(); failTransition(f, 'banning', 'unbanning');
    f.api.getBan.mockResolvedValueOnce(null).mockResolvedValueOnce({ reason: 'admin' });
    await f.makeWorker().run(job); expect(f.api.unban).not.toHaveBeenCalled();
  } finally { f.close(); }
});
it('late emergency lookup cannot dispatch unban after 10 seconds', async () => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    const job = f.enqueue(); failTransition(f, 'banning', 'unbanning');
    let release!: (value: { reason: string }) => void;
    f.api.getBan.mockResolvedValueOnce(null).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const running = f.makeWorker().run(job);
    await vi.waitFor(() => expect(f.onFatal).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(10001); release({ reason: job.reason }); await running;
    expect(f.api.unban).not.toHaveBeenCalled();
  } finally { f.close(); vi.useRealTimers(); }
});
it('unban accepted with timeout is reconciled on retry as absent', async () => {
  const f = fixture();
  try {
    const job = f.enqueue(); f.api.unban.mockImplementationOnce(async (_g, u) => { f.remote.delete(u); throw new ApiFailure('transient', 'ETIMEDOUT'); });
    await f.makeWorker().run(job); expect(f.jobs.get(job.id).state).toBe('unbanning');
    f.advance(1000); f.reopen(); await f.makeWorker().run(job); expect(f.jobs.get(job.id).state).toBe('completed'); expect(f.api.ban).toHaveBeenCalledOnce();
  } finally { f.close(); }
});
