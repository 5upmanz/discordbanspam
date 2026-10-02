import { expect, it, vi } from 'vitest';
import { createStatusPanel, createStatusStore, statusPayload } from '../src/status-panel.js';
import { openDatabase } from '../src/db.js';
import { createJobs } from '../src/jobs.js';
import { fixture } from './helpers.js';

it('renders the requested GIF and a disabled Thai counter without mentions', () => {
  const payload = statusPayload(12);
  expect(payload.embeds[0]).toMatchObject({ title: 'ห้องกับดัก • Softban', description: 'ส่งข้อความในห้องนี้จะถูกllบu' });
  expect(payload.embeds[0].image?.url).toBe('https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExdndubTU3NjhxenZpb3hjbDV3dTY0N3NpMmh6ZDJvZjV0Z2xvY2c3byZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/26ufgbn5OaTw6604o/giphy.gif');
  expect(payload.components[0].components[0]).toMatchObject({ label: 'โดนไปแล้ว 12 ครั้ง', disabled: true });
  expect(payload.allowedMentions).toEqual({ parse: [] });
});

it('counts completed softbans, not queued, failed or manually resolved jobs; survives restart', async () => {
  const f = fixture();
  try {
    await f.makeWorker().run(f.enqueue());
    f.enqueue('m2', 'u2');
    const failed = f.enqueue('m3', 'u3'); f.jobs.change(failed.id, 'queued', { state: 'failed' }, 1000);
    const manual = f.enqueue('m4', 'u4'); f.jobs.change(manual.id, 'queued', { state: 'manual_review' }, 1000); f.jobs.change(manual.id, 'manual_review', { state: 'completed' }, 1000);
    // Read through a second connection to verify committed, durable state.
    f.reopen();
    expect(f.jobs.successfulCount()).toBe(1);
  } finally { f.close(); }
});

it('shares the persisted status message ID between repository instances', () => {
  const db = openDatabase(':memory:', { guildId: 'g', channelId: 'c' });
  try {
    const store = createStatusStore(db, createJobs(db));
    expect(store.read()).toEqual({ count: 0, messageId: null });
    store.saveMessageId('panel');
    expect(createStatusStore(db, createJobs(db)).read()).toEqual({ count: 0, messageId: 'panel' });
  } finally { db.close(); }
});

it('creates once, reuses the saved message and only edits when the count changes', async () => {
  vi.useFakeTimers();
  let count = 0, messageId: string | null = null;
  const writes: Array<{ id: string | null; count: number }> = [];
  const panel = createStatusPanel({
    store: { read: () => ({ count, messageId }), saveMessageId: id => { messageId = id; } },
    publish: async (id, total) => { writes.push({ id, count: total }); return 'panel'; },
    log: { emit: vi.fn() },
  });
  try {
    panel.start(); await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual([{ id: null, count: 0 }]);
    await vi.advanceTimersByTimeAsync(5000); expect(writes).toHaveLength(1);
    count = 1; await vi.advanceTimersByTimeAsync(5000);
    expect(writes[1]).toEqual({ id: 'panel', count: 1 });
    await panel.stop();
    panel.start(); await vi.advanceTimersByTimeAsync(0);
    expect(writes[2]).toEqual({ id: 'panel', count: 1 });
  } finally { await panel.stop(); vi.useRealTimers(); }
});

it('bounds shutdown when a panel request hangs', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const panel = createStatusPanel({
    store: { read: () => ({ count: 0, messageId: 'panel' }), saveMessageId: () => {} },
    publish: () => new Promise<string>(resolve => { release = () => resolve('panel'); }),
    log: { emit: vi.fn() },
  });
  try {
    panel.start(); await vi.advanceTimersByTimeAsync(0);
    const stopping = panel.stop(10); await vi.advanceTimersByTimeAsync(11);
    expect(await stopping).toBe(false);
    release(); await panel.stop();
  } finally { release?.(); await panel.stop(); vi.useRealTimers(); }
});

it('retries failed publication and drains in-flight publication before stopping', async () => {
  vi.useFakeTimers();
  let attempts = 0, release!: () => void;
  const log = { emit: vi.fn() };
  const panel = createStatusPanel({
    store: { read: () => ({ count: 0, messageId: 'panel' }), saveMessageId: () => {} },
    publish: async () => { if (++attempts === 1) throw new Error('private'); await new Promise<void>(resolve => { release = resolve; }); return 'panel'; }, log,
  });
  try {
    panel.start(); await vi.advanceTimersByTimeAsync(0);
    expect(log.emit).toHaveBeenCalledWith('warn', 'status_panel_failed', { errorCode: 'STATUS_PANEL_FAILURE' });
    await vi.advanceTimersByTimeAsync(5000);
    let stopped = false; const stopping = panel.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    release(); await stopping; await vi.advanceTimersByTimeAsync(10000);
    expect(attempts).toBe(2);
  } finally { release?.(); await panel.stop(); vi.useRealTimers(); }
});
