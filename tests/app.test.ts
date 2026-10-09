import { expect, it, vi } from 'vitest';
import { createApp, type ClientPort } from '../src/app.js';
import type { StatusPanel } from '../src/status-panel.js';
import type { MessageEnvelope } from '../src/trap-handler.js';
import { fixture } from './helpers.js';

it('starts the panel only after preflight and drains it before closing the database', async () => {
  let release!: () => void, active = false;
  const panel: StatusPanel = {
    start() { active = true; },
    stop: () => new Promise<boolean>(resolve => { release = () => { active = false; resolve(true); }; }),
  };
  const { f, app, close } = setup(panel);
  try {
    await app.start(); expect(active).toBe(true);
    const stopping = app.stop(); await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    release(); await stopping;
    expect(active).toBe(false); expect(close).toHaveBeenCalledOnce();
  } finally { release?.(); await app.stop(); f.close(); }
});
it('keeps the database open when the panel cannot drain before shutdown', async () => {
  const panel: StatusPanel = { start() {}, stop: async () => false };
  const { f, app, close, exit } = setup(panel);
  try {
    await app.start(); expect(await app.stop()).toBe(false);
    expect(close).not.toHaveBeenCalled(); expect(exit).toHaveBeenCalledWith(1);
  } finally { await app.stop(); f.close(); }
});
function fakeClient() {
  let ready = () => {}, message = (_m: MessageEnvelope) => {}, connection = (_v: boolean) => {}, error = (_e: unknown) => {};
  const port: ClientPort = {
    selfId: () => 'self', login: vi.fn(async () => { ready(); }), destroy: vi.fn(async () => {}),
    onReady: fn => { ready = fn; }, onMessage: fn => { message = fn; }, onConnection: fn => { connection = fn; }, onError: fn => { error = fn; },
  };
  return { port, send: (m: MessageEnvelope) => message(m), connect: (v: boolean) => connection(v), ready: () => ready(), fail: (e: unknown) => error(e) };
}
const message: MessageEnvelope = { id: 'm', guildId: 'g', channelId: 'c', authorId: 'u', webhookId: null, system: false };
function setup(statusPanel?: StatusPanel) {
  const f = fixture(), client = fakeClient(), close = vi.fn(), exit = vi.fn();
  const app = createApp({ config: { token: 'test', guildId: 'g', trapChannelId: 'c', statusGifUrl: 'https://example.com/status.gif', databasePath: 'unused', logLevel: 'info' }, client: client.port, api: f.api, jobs: f.jobs, clock: f.clock, log: f.log, closeDatabase: close, exit, statusPanel });
  return { f, client, close, exit, app };
}
it('gates pending preflight then processes messages, stops idempotently', async () => {
  const { f, client, close, app } = setup();
  let release!: () => void; f.api.preflight.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  try {
    const starting = app.start(); await vi.waitFor(() => expect(f.api.preflight).toHaveBeenCalledOnce());
    client.send(message); expect(f.jobs.recoverable()).toEqual([]);
    release(); await starting; client.send(message);
    await vi.waitFor(() => expect(f.calls).toEqual(['ban','unban']));
    expect(await app.stop()).toBe(true); expect(await app.stop()).toBe(true); expect(close).toHaveBeenCalledOnce();
    client.send({ ...message, id: 'm2' }); expect(f.api.ban).toHaveBeenCalledOnce();
  } finally { release?.(); await app.stop(); f.close(); }
});
it('failed preflight leaves intake off but recovers an owned ban first', async () => {
  const { f, client, app } = setup();
  try {
    const job = f.enqueue(); f.jobs.change(job.id, 'queued', { state: 'banning', banStartedAt: 1000 }, 1000); f.remote.set('u', { reason: job.reason });
    f.api.preflight.mockRejectedValue(new Error('missing channel'));
    await expect(app.start()).rejects.toThrow('missing channel');
    client.send({ ...message, id: 'm2' }); expect(f.api.ban).not.toHaveBeenCalled(); expect(f.api.unban).toHaveBeenCalledOnce();
  } finally { await app.stop(); f.close(); }
});
it('stale reconnect preflight cannot enable intake after a later disconnect', async () => {
  const { f, client, app } = setup();
  let release!: () => void;
  try {
    await app.start(); client.connect(false);
    f.api.preflight.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    client.connect(true); await vi.waitFor(() => expect(f.api.preflight).toHaveBeenCalledTimes(2));
    client.connect(false); release(); await Promise.resolve(); await Promise.resolve();
    client.send(message); expect(f.jobs.recoverable()).toEqual([]);
    client.connect(true); await vi.waitFor(() => expect(f.api.preflight).toHaveBeenCalledTimes(3));
    await Promise.resolve(); client.send(message); await vi.waitFor(() => expect(f.api.ban).toHaveBeenCalledOnce());
  } finally { release?.(); await app.stop(); f.close(); }
});
it('stale failed preflight cannot disable a newer ready connection', async () => {
  const { f, client, app } = setup();
  let reject!: (error: Error) => void;
  try {
    await app.start(); client.connect(false);
    f.api.preflight.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    client.connect(true);
    await vi.waitFor(() => expect(f.api.preflight).toHaveBeenCalledTimes(2));
    client.connect(false); client.connect(true);
    await vi.waitFor(() => expect(f.api.preflight).toHaveBeenCalledTimes(3));
    reject(new Error('stale failure')); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    client.send(message); await vi.waitFor(() => expect(f.api.ban).toHaveBeenCalledOnce());
  } finally { await app.stop(); f.close(); }
});

it('fatal storage failure disables intake immediately and exits nonzero after drain', async () => {
  const { f, client, close, exit, app } = setup();
  try {
    await app.start(); vi.spyOn(f.jobs, 'accept').mockImplementation(() => { throw new Error('disk full'); });
    client.send(message); client.send({ ...message, id: 'm2' });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(close).toHaveBeenCalledOnce(); expect(f.api.ban).not.toHaveBeenCalled();
  } finally { await app.stop(); f.close(); }
});
it('shutdown timeout never closes database underneath pending worker', async () => {
  vi.useFakeTimers(); const { f, client, close, exit, app } = setup(); let release!: () => void;
  try {
    await app.start(); f.api.ban.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    client.send(message); await vi.advanceTimersByTimeAsync(0);
    const stopping = app.stop(); await vi.advanceTimersByTimeAsync(15001); expect(await stopping).toBe(false);
    expect(close).not.toHaveBeenCalled(); expect(exit).toHaveBeenCalledWith(1);
    release(); await vi.advanceTimersByTimeAsync(0);
  } finally { release?.(); await app.stop(); f.close(); vi.useRealTimers(); }
});
