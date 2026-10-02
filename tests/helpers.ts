import { vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { createJobs } from '../src/jobs.js';
import { createWorker } from '../src/softban-worker.js';
import type { DiscordPort } from '../src/contracts.js';
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'softban-worker-'));
  const path = join(dir, 'jobs.sqlite');
  const scope = { guildId: 'g', channelId: 'c' };
  let db = openDatabase(path, scope), jobs = createJobs(db), now = 1000;
  const remote = new Map<string, { reason: string | null }>();
  const calls: string[] = [];
  const api = {
    preflight: vi.fn<DiscordPort['preflight']>().mockResolvedValue(undefined),
    canBan: vi.fn<DiscordPort['canBan']>().mockResolvedValue(undefined),
    getBan: vi.fn<DiscordPort['getBan']>().mockImplementation(async (_g, u) => remote.get(u) ?? null),
    ban: vi.fn<DiscordPort['ban']>().mockImplementation(async (_g, u, reason) => { calls.push('ban'); remote.set(u, { reason }); }),
    unban: vi.fn<DiscordPort['unban']>().mockImplementation(async (_g, u) => { calls.push('unban'); remote.delete(u); }),
  };
  const clock = { now: () => now, random: () => 0 }, log = { emit: vi.fn() }, onFatal = vi.fn();
  return {
    get jobs() { return jobs; }, api, remote, calls, clock, log, onFatal,
    advance(ms: number) { now += ms; },
    makeWorker() { return createWorker({ jobs, api, clock, log, onFatal }); },
    enqueue(messageId = 'm', userId = 'u') { return jobs.accept({ ...scope, messageId, userId }, now).job; },
    reopen() { db.close(); db = openDatabase(path, scope); jobs = createJobs(db); },
    close() { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
