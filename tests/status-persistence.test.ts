import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createJobs } from '../src/jobs.js';
import { createStatusStore } from '../src/status-panel.js';

it('migrates v1 completed jobs without counting operator resolutions and preserves dedup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-migration-')), path = join(dir, 'jobs.sqlite');
  const scope = { guildId: 'g', channelId: 'c' };
  let db = openDatabase(path, scope);
  try {
    const jobs = createJobs(db);
    for (const userId of ['normal', 'manual']) {
      const job = jobs.accept({ ...scope, userId, messageId: userId }, 1000).job;
      jobs.change(job.id, 'queued', { state: 'banning', banStartedAt: 1000 }, 1000);
      jobs.change(job.id, 'banning', { state: 'unbanning' }, 1000);
      jobs.change(job.id, 'unbanning', { state: 'completed', lastError: userId === 'manual' ? 'OPERATOR_RESOLVED' : null }, 1000);
    }
    // Remove only the new table to model an existing v1 schema with durable jobs.
    db.exec('DROP TABLE status_panel; PRAGMA user_version = 1;');
    db.close(); db = openDatabase(path, scope);
    const migrated = createJobs(db), store = createStatusStore(db, migrated);
    expect(store.read()).toEqual({ count: 1, messageId: null });
    expect(migrated.accept({ ...scope, userId: 'normal', messageId: 'normal' }, 2000).kind).toBe('duplicate');
    store.saveMessageId('123'); db.close(); db = openDatabase(path, scope);
    expect(createStatusStore(db, createJobs(db)).read()).toEqual({ count: 1, messageId: '123' });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('rolls back completion when the durable counter cannot be written', () => {
  const db = openDatabase(':memory:', { guildId: 'g', channelId: 'c' });
  try {
    const jobs = createJobs(db);
    const job = jobs.accept({ guildId: 'g', channelId: 'c', userId: 'u', messageId: 'm' }, 1).job;
    jobs.change(job.id, 'queued', { state: 'banning' }, 1);
    jobs.change(job.id, 'banning', { state: 'unbanning' }, 1);
    db.exec("CREATE TRIGGER counter_failure BEFORE UPDATE ON status_panel BEGIN SELECT RAISE(ABORT, 'disk failure'); END;");
    expect(() => jobs.change(job.id, 'unbanning', { state: 'completed' }, 2)).toThrow('disk failure');
    expect(jobs.get(job.id).state).toBe('unbanning'); expect(jobs.successfulCount()).toBe(0);
    db.exec('DROP TRIGGER counter_failure');
    jobs.change(job.id, 'unbanning', { state: 'completed' }, 3);
    expect(jobs.successfulCount()).toBe(1);
    expect(() => jobs.change(job.id, 'completed', { state: 'completed' }, 4)).toThrow();
    expect(jobs.successfulCount()).toBe(1);
  } finally { db.close(); }
});
