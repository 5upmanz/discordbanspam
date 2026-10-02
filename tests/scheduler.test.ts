import { expect, it, vi } from 'vitest';
import { createScheduler } from '../src/scheduler.js';
import { fixture } from './helpers.js';
it('never overlaps wake calls and drains on stop', async () => {
  const f = fixture();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const run = vi.fn(async () => { await blocked; });
  const scheduler = createScheduler({ jobs: f.jobs, clock: f.clock, worker: { run, checkAlerts: vi.fn() }, onFatal: f.onFatal });
  try {
    f.enqueue(); scheduler.start(); scheduler.wake(); scheduler.wake();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const stop = scheduler.stop(1000); release(); expect(await stop).toBe(true);
    scheduler.wake(); expect(await scheduler.stop(1000)).toBe(true); expect(run).toHaveBeenCalledOnce();
  } finally { release(); await scheduler.stop(1000); f.close(); }
});
it('polls future jobs, checks alerts with no jobs, prioritizes unban', async () => {
  vi.useFakeTimers(); const f = fixture();
  const alerts = vi.fn(), worker = f.makeWorker();
  const scheduler = createScheduler({ jobs: f.jobs, clock: f.clock, worker: { run: worker.run, checkAlerts: alerts }, onFatal: f.onFatal });
  try {
    const queued = f.enqueue('m1', 'a'), owned = f.enqueue('m2', 'b');
    f.jobs.change(owned.id, 'queued', { state: 'banning', banStartedAt: 1000 }, 1000);
    f.jobs.change(owned.id, 'banning', { state: 'unbanning' }, 1000); f.remote.set('b', { reason: owned.reason });
    f.jobs.change(queued.id, 'queued', { nextAttemptAt: 2000 }, 1000);
    scheduler.start(); await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toEqual(['unban']); expect(f.jobs.get(queued.id).state).toBe('queued');
    f.advance(1000); await vi.advanceTimersByTimeAsync(1000);
    expect(f.calls).toEqual(['unban', 'ban', 'unban']);
    await vi.advanceTimersByTimeAsync(1000); expect(alerts.mock.calls.length).toBeGreaterThan(1);
  } finally { await scheduler.stop(1000); f.close(); vi.useRealTimers(); }
});
it('timeout does not start another worker or imply cancellation', async () => {
  vi.useFakeTimers(); const f = fixture(); let release!: () => void;
  const run = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const scheduler = createScheduler({ jobs: f.jobs, clock: f.clock, worker: { run, checkAlerts: vi.fn() }, onFatal: f.onFatal });
  try {
    f.enqueue(); scheduler.start(); await vi.advanceTimersByTimeAsync(0);
    const stop = scheduler.stop(100); await vi.advanceTimersByTimeAsync(101); expect(await stop).toBe(false);
    scheduler.wake(); expect(run).toHaveBeenCalledOnce(); release(); expect(await scheduler.stop(100)).toBe(true);
  } finally { release?.(); await scheduler.stop(100); f.close(); vi.useRealTimers(); }
});
it('repository failure stops scheduling and invokes fatal once', async () => {
  const f = fixture(); vi.spyOn(f.jobs, 'nextDue').mockImplementation(() => { throw new Error('disk'); });
  const scheduler = createScheduler({ jobs: f.jobs, clock: f.clock, worker: f.makeWorker(), onFatal: f.onFatal });
  try { scheduler.start(); await vi.waitFor(() => expect(f.onFatal).toHaveBeenCalledOnce()); scheduler.wake(); expect(await scheduler.stop(1000)).toBe(true); expect(f.onFatal).toHaveBeenCalledOnce(); }
  finally { await scheduler.stop(1000); f.close(); }
});
