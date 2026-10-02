import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db.js';
import { createJobs } from '../src/jobs.js';
import type { Job } from '../src/contracts.js';

const scope = { guildId: '111111111111111111', channelId: '222222222222222222' };
const trigger = { ...scope, userId: '333333333333333333', messageId: '444444444444444444' };

it('persists coalesced message dedup across reopen and completion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'softban-'));
  const path = join(dir, 'jobs.sqlite');
  let db = openDatabase(path, scope);
  try {
    let jobs = createJobs(db);
    const first = jobs.accept(trigger, 10);
    const second = { ...trigger, messageId: '555555555555555555' };
    expect(jobs.accept(second, 11).kind).toBe('coalesced');
    jobs.change(first.job.id, 'queued', { state: 'failed' }, 12);
    db.close();
    db = openDatabase(path, scope);
    jobs = createJobs(db);
    expect(jobs.accept(second, 13).kind).toBe('duplicate');
    expect(jobs.accept({ ...trigger, messageId: '666666666666666666' }, 14).kind).toBe('created');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('enforces database pragmas and bound scope, and returns fresh snapshots', () => {
  const db = openDatabase(':memory:', scope);
  try {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('synchronous', { simple: true })).toBe(2);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    const jobs = createJobs(db), job = jobs.accept(trigger, 1).job;
    expect(() => jobs.accept({ ...trigger, guildId: 'other', messageId: 'new' }, 2)).toThrow(/scope/i);
    job.state = 'completed';
    expect(jobs.get(job.id).state).toBe('queued');
    expect(() => jobs.change(job.id, 'queued', { state: 'unbanning' }, 2)).toThrow(/transition/i);
  } finally { db.close(); }
});

it('manual review retains the per-user lock', () => {
  const db = openDatabase(':memory:', scope);
  try {
    const jobs = createJobs(db);
    const { job } = jobs.accept(trigger, 1);
    jobs.change(job.id, 'queued', { state: 'manual_review' }, 2);
    expect(jobs.accept({ ...trigger, messageId: '555555555555555555' }, 3).kind).toBe(
      'coalesced',
    );
    expect(jobs.nextDue(999)).toBeNull();
  } finally {
    db.close();
  }
});

it('rejects a different scope on the same database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'softban-'));
  const path = join(dir, 'jobs.sqlite');
  openDatabase(path, scope).close();
  expect(() =>
    openDatabase(path, { guildId: '999999999999999999', channelId: scope.channelId }),
  ).toThrow(/scope/i);
  expect(() =>
    openDatabase(path, { guildId: scope.guildId, channelId: '999999999999999999' }),
  ).toThrow(/scope/i);
});

it('rejects an unknown or newer schema version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'softban-'));
  const path = join(dir, 'jobs.sqlite');
  openDatabase(path, scope).close();
  const raw = new Database(path);
  raw.pragma('user_version = 99');
  raw.close();
  expect(() => openDatabase(path, scope)).toThrow(/version/i);
  rmSync(dir, { recursive: true, force: true });
});

it('persists retry metadata and rejects wrong expected state', () => {
  const db = openDatabase(':memory:', scope);
  try {
    const jobs = createJobs(db);
    const { job } = jobs.accept(trigger, 1);
    const updated = jobs.change(
      job.id,
      'queued',
      { state: 'banning', banStartedAt: 5, attempts: 1, nextAttemptAt: 6, lastError: 'ETIMEDOUT' },
      5,
    );
    expect(updated).toMatchObject({
      state: 'banning',
      banStartedAt: 5,
      attempts: 1,
      nextAttemptAt: 6,
      lastError: 'ETIMEDOUT',
      updatedAt: 5,
    });
    expect(() => jobs.change(job.id, 'queued', { state: 'unbanning' }, 6)).toThrow(
      /state/i,
    );
  } finally {
    db.close();
  }
});

it('rejects illegal transitions and terminal states', () => {
  const db = openDatabase(':memory:', scope);
  try {
    const jobs = createJobs(db);
    const { job } = jobs.accept(trigger, 1);
    jobs.change(job.id, 'queued', { state: 'failed' }, 2);
    expect(() => jobs.change(job.id, 'failed', { state: 'queued' }, 3)).toThrow(
      /transition|state/i,
    );
    const { job: j2 } = jobs.accept({ ...trigger, messageId: '777777777777777777' }, 4);
    jobs.change(j2.id, 'queued', { state: 'banning', banStartedAt: 4 }, 4);
    jobs.change(j2.id, 'banning', { state: 'unbanning' }, 5);
    jobs.change(j2.id, 'unbanning', { state: 'completed' }, 6);
    expect(() => jobs.change(j2.id, 'completed', { state: 'failed' }, 7)).toThrow(
      /transition|state/i,
    );
  } finally {
    db.close();
  }
});

it('orders nextDue by phase priority then due time', () => {
  const db = openDatabase(':memory:', scope);
  try {
    const jobs = createJobs(db);
    const a = jobs.accept({ ...trigger, userId: 'a', messageId: 'a' }, 1).job;
    const b = jobs.accept({ ...trigger, userId: 'b', messageId: 'b' }, 2).job;
    const c = jobs.accept({ ...trigger, userId: 'c', messageId: 'c' }, 3).job;
    jobs.change(a.id, 'queued', { state: 'queued', nextAttemptAt: 50 }, 1);
    jobs.change(b.id, 'queued', { state: 'banning', banStartedAt: 2, nextAttemptAt: 40 }, 2);
    jobs.change(c.id, 'queued', { state: 'banning', banStartedAt: 3 }, 3);
    jobs.change(c.id, 'banning', { state: 'unbanning', nextAttemptAt: 30 }, 3);
    expect(jobs.nextDue(20)).toBeNull();
    expect(jobs.nextDue(30)?.id).toBe(c.id);
    expect(jobs.nextDue(50)?.id).toBe(c.id);
    jobs.change(c.id, 'unbanning', { state: 'completed' }, 50);
    expect(jobs.nextDue(50)?.id).toBe(b.id);
    jobs.change(b.id, 'banning', { state: 'failed' }, 50);
    expect(jobs.nextDue(50)?.id).toBe(a.id);
  } finally {
    db.close();
  }
});

it('recoverable lists active jobs in priority order even when future-due', () => {
  const db = openDatabase(':memory:', scope);
  try {
    const jobs = createJobs(db);
    const a = jobs.accept({ ...trigger, userId: 'a', messageId: 'a' }, 1).job;
    const b = jobs.accept({ ...trigger, userId: 'b', messageId: 'b' }, 2).job;
    jobs.change(a.id, 'queued', { state: 'banning', banStartedAt: 1, nextAttemptAt: 999 }, 1);
    jobs.change(b.id, 'queued', { state: 'banning', banStartedAt: 2 }, 2);
    jobs.change(b.id, 'banning', { state: 'unbanning', nextAttemptAt: 999 }, 2);
    expect(jobs.recoverable().map((j: Job) => j.id)).toEqual([b.id, a.id]);
    expect(jobs.recoverable().map((j: Job) => j.id)).toEqual([b.id, a.id]);
  } finally {
    db.close();
  }
});

it('overdue reports unresolved bans with alert throttling window', () => {
  const db = openDatabase(':memory:', scope);
  try {
    const jobs = createJobs(db);
    const { job } = jobs.accept(trigger, 1);
    jobs.change(job.id, 'queued', { state: 'banning', banStartedAt: 1000 }, 1000);
    expect(jobs.overdue(1000 + 60000)).toHaveLength(1);
    expect(jobs.overdue(1000 + 59999)).toHaveLength(0);
    jobs.change(job.id, 'banning', { lastAlertAt: 1000 + 60000 }, 1000 + 60000);
    expect(jobs.overdue(1000 + 60000 + 299999)).toHaveLength(0);
    expect(jobs.overdue(1000 + 60000 + 300000)).toHaveLength(1);
  } finally {
    db.close();
  }
});

it('rolls back the whole accept transaction on failure', () => {
  const db = openDatabase(':memory:', scope);
  try {
    const originalPrepare = db.prepare.bind(db);
    const cache = new Map<string, Database.Statement>();
    const spy = vi
      .spyOn(db, 'prepare')
      .mockImplementation((sql: string) => {
        const key = String(sql).replace(/\s+/g, ' ').trim();
        if (!cache.has(key)) cache.set(key, originalPrepare(sql));
        return cache.get(key)!;
      });
    const jobs = createJobs(db);
    const seenKey = [...cache.keys()].find((k) =>
      k.includes('INSERT INTO seen_messages'),
    );
    expect(seenKey).toBeDefined();
    const seenStmt = cache.get(seenKey!)!;
    const realRun = seenStmt.run.bind(seenStmt);
    seenStmt.run = (() => {
      throw new Error('disk full');
    }) as typeof seenStmt.run;
    expect(() => jobs.accept(trigger, 1)).toThrow('disk full');
    expect(jobs.recoverable()).toEqual([]);
    seenStmt.run = realRun;
    expect(jobs.accept(trigger, 2).kind).toBe('created');
    spy.mockRestore();
  } finally {
    db.close();
  }
});

it('keeps one locked job for 20 messages and dedupes after completion', () => {
  const db = openDatabase(':memory:', scope);
  try {
    const jobs = createJobs(db);
    const ids: string[] = [];
    let job: Job | undefined;
    for (let i = 0; i < 20; i++) {
      const result = jobs.accept(
        { ...trigger, messageId: `90000000000000000${i}` },
        i + 1,
      );
      if (result.kind === 'created') job = result.job;
      ids.push(`90000000000000000${i}`);
    }
    expect(job).toBeDefined();
    expect(jobs.recoverable()).toHaveLength(1);
    const j = job!;
    jobs.change(j.id, 'queued', { state: 'banning', banStartedAt: 1 }, 1);
    jobs.change(j.id, 'banning', { state: 'unbanning' }, 2);
    jobs.change(j.id, 'unbanning', { state: 'completed' }, 3);
    for (const id of ids) {
      expect(jobs.accept({ ...trigger, messageId: id }, 100).kind).toBe('duplicate');
    }
  } finally {
    db.close();
  }
});
