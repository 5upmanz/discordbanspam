import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Job, Jobs, JobPatch, State, Trigger } from './contracts.js';

const transitions: Record<State, readonly State[]> = {
  queued: ['banning', 'failed', 'manual_review'],
  banning: ['unbanning', 'failed', 'manual_review'],
  unbanning: ['completed', 'manual_review'],
  manual_review: ['completed', 'failed'], completed: [], failed: [],
};
const columns = ['state', 'ownership', 'banStartedAt', 'attempts', 'nextAttemptAt', 'lastError', 'lastAlertAt'] as const;
const priority = "CASE state WHEN 'unbanning' THEN 0 WHEN 'banning' THEN 1 ELSE 2 END, createdAt, id";

export function createJobs(db: Database.Database): Jobs {
  const select = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const seen = db.prepare('SELECT jobId FROM seen_messages WHERE guildId = ? AND messageId = ?');
  const locked = db.prepare("SELECT * FROM jobs WHERE guildId = ? AND userId = ? AND state IN ('queued','banning','unbanning','manual_review')");
  const insert = db.prepare(`INSERT INTO jobs (id,guildId,channelId,userId,messageId,reason,state,ownership,createdAt,updatedAt,banStartedAt,attempts,nextAttemptAt,lastError,lastAlertAt)
    VALUES (@id,@guildId,@channelId,@userId,@messageId,@reason,@state,@ownership,@createdAt,@updatedAt,@banStartedAt,@attempts,@nextAttemptAt,@lastError,@lastAlertAt)`);
  const insertSeen = db.prepare('INSERT INTO seen_messages (guildId,messageId,jobId,receivedAt) VALUES (?,?,?,?)');
  const scope = db.prepare('SELECT guildId, channelId FROM scope WHERE singleton = 1').get() as { guildId: string; channelId: string };
  function get(id: string): Job {
    const row = select.get(id) as Job | undefined;
    if (!row) throw new Error('Job not found');
    return row;
  }
  const accept = db.transaction((trigger: Trigger, now: number) => {
    if (trigger.guildId !== scope.guildId || trigger.channelId !== scope.channelId) throw new Error('Job scope mismatch');
    const duplicate = seen.get(trigger.guildId, trigger.messageId) as { jobId: string } | undefined;
    if (duplicate) return { kind: 'duplicate' as const, job: get(duplicate.jobId) };
    let job = locked.get(trigger.guildId, trigger.userId) as Job | undefined;
    const kind = job ? 'coalesced' as const : 'created' as const;
    if (!job) {
      const id = randomUUID();
      job = { ...trigger, id, reason: `trap-softban:${id}`, state: 'queued', ownership: 'unchecked', createdAt: now, updatedAt: now, banStartedAt: null, attempts: 0, nextAttemptAt: now, lastError: null, lastAlertAt: null };
      insert.run(job);
    }
    insertSeen.run(trigger.guildId, trigger.messageId, job.id, now);
    return { kind, job };
  });
  const change = db.transaction((id: string, expected: State, patch: JobPatch, now: number): Job => {
    const job = get(id);
    if (job.state !== expected) throw new Error('Unexpected job state');
    const target = patch.state ?? expected;
    if (expected === 'completed' || expected === 'failed' || (target !== expected && !transitions[expected].includes(target))) throw new Error('Illegal state transition');
    const keys = columns.filter(key => patch[key] !== undefined);
    if (Object.keys(patch).some(key => !columns.includes(key as typeof columns[number]))) throw new Error('Unknown job patch column');
    const assignments = [...keys.map(key => `${key} = ?`), 'updatedAt = ?'];
    const values = keys.map(key => patch[key] as string | number | null);
    const result = db.prepare(`UPDATE jobs SET ${assignments.join(', ')} WHERE id = ? AND state = ?`).run(...values, now, id, expected);
    if (result.changes !== 1) throw new Error('Unexpected job state');
    if (expected === 'unbanning' && target === 'completed') {
      db.prepare('UPDATE status_panel SET successfulCount = successfulCount + 1 WHERE singleton = 1').run();
    }
    return get(id);
  });
  return {
    accept, get, change,
    successfulCount: () => (db.prepare('SELECT successfulCount FROM status_panel WHERE singleton = 1').get() as { successfulCount: number }).successfulCount,
    nextDue: now => (db.prepare(`SELECT * FROM jobs WHERE state IN ('queued','banning','unbanning') AND nextAttemptAt <= ? ORDER BY ${priority} LIMIT 1`).get(now) as Job | undefined) ?? null,
    recoverable: () => db.prepare(`SELECT * FROM jobs WHERE state IN ('queued','banning','unbanning') ORDER BY ${priority}`).all() as Job[],
    overdue: now => db.prepare("SELECT * FROM jobs WHERE state IN ('banning','unbanning','manual_review') AND banStartedAt IS NOT NULL AND banStartedAt <= ? AND (lastAlertAt IS NULL OR lastAlertAt <= ?)").all(now - 60000, now - 300000) as Job[],
  };
}
