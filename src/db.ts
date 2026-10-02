import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path: string, scope: { guildId: string; channelId: string }): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    const version = db.pragma('user_version', { simple: true });
    if (version !== 0 && version !== 1 && version !== 2) throw new Error('Unsupported database schema version');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.transaction(() => {
      if (version === 0) {
        db.exec(`
          CREATE TABLE scope (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), guildId TEXT NOT NULL, channelId TEXT NOT NULL);
          CREATE TABLE jobs (
            id TEXT PRIMARY KEY, guildId TEXT NOT NULL, channelId TEXT NOT NULL,
            userId TEXT NOT NULL, messageId TEXT NOT NULL, reason TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL CHECK(state IN ('queued','banning','unbanning','completed','failed','manual_review')),
            ownership TEXT NOT NULL CHECK(ownership IN ('unchecked','matched','absent','foreign','unknown')),
            createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, banStartedAt INTEGER,
            attempts INTEGER NOT NULL DEFAULT 0, nextAttemptAt INTEGER NOT NULL, lastError TEXT, lastAlertAt INTEGER
          );
          CREATE UNIQUE INDEX jobs_user_lock ON jobs(guildId, userId) WHERE state IN ('queued','banning','unbanning','manual_review');
          CREATE TABLE seen_messages (guildId TEXT NOT NULL, messageId TEXT NOT NULL, jobId TEXT NOT NULL REFERENCES jobs(id), receivedAt INTEGER NOT NULL, PRIMARY KEY(guildId,messageId));
          CREATE INDEX jobs_due ON jobs(state,nextAttemptAt);
          PRAGMA user_version = 1;
        `);
        db.prepare('INSERT INTO scope VALUES (1, ?, ?)').run(scope.guildId, scope.channelId);
      }
      if (version !== 2) {
        db.exec(`
          CREATE TABLE status_panel (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), messageId TEXT, successfulCount INTEGER NOT NULL DEFAULT 0);
          INSERT INTO status_panel (singleton, successfulCount)
            SELECT 1, COUNT(*) FROM jobs WHERE state = 'completed' AND lastError IS NULL AND banStartedAt IS NOT NULL;
          PRAGMA user_version = 2;
        `);
      }
      const stored = db.prepare('SELECT guildId, channelId FROM scope WHERE singleton = 1').get() as typeof scope | undefined;
      if (!stored || stored.guildId !== scope.guildId || stored.channelId !== scope.channelId) throw new Error('Database scope mismatch');
    })();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
