# Discord Trap Channel Softban Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** เฝ้าห้อง Discord ที่กำหนด ใครส่งข้อความให้ softban พร้อมร้องขอลบข้อความย้อนหลัง 7 วัน โดยกู้คืนงานหลังบอทล่มได้

**Architecture:** Gateway events create durable, deduplicated SQLite jobs. A single worker performs ownership-checked ban/unban, prioritizes recovery, and never blindly repeats an uncertain ban. Discord API calls sit behind a mockable adapter; no content inspection or privileged intents are required.

**Tech Stack:** Node.js 24 LTS, TypeScript strict, discord.js 14, better-sqlite3, Vitest, npm.

**Spec:** `docs/superpowers/specs/2026-09-13-discord-trap-softban-design.md` — approved by the user in chat. Read it completely before implementation.

## Execution progress

- [x] Review fixes: test syntax, unique message IDs, legal transitions, event redaction regression.
- [x] Task 1 verified with existing toolchain/config and logger regression.
- [x] Task 2 implemented and verified: 29 tests, typecheck/build passed.
- [x] Task 3 implemented and verified: 37 tests, typecheck/build passed.
- [x] Task 4 implemented and verified: 38 tests, typecheck/build passed.
- [x] Task 5: worker and durable retries; 52 tests, typecheck/build passed at checkpoint.
- [x] Task 6: recovery/failure boundaries; 67 tests, typecheck/build passed at checkpoint.
- [x] Task 7: scheduler/lifecycle/entry point; 83 tests, typecheck/build passed, including stale reconnect regression.
- [x] Task 8: README, clean install, final 88 tests, typecheck/build and real SQLite smoke passed. Incomplete-config compiled entry exits 1 before login.

Final verification: Node 24.19.0, npm 11.17.0, Windows x64. `npm ci` initially attempted an implicit node-gyp build and failed due to missing Visual Studio C++ tools. The locked better-sqlite3 package already ships a working native binary. Added project `.npmrc` with `ignore-scripts=true`, verified native SQLite directly, then repeated plain `npm ci`, typecheck, all 88 tests and build successfully. Dependency-upgrade caveat documented in README. No real token/API, deployment or Git repository used.

Implementation note: `src/client-port.ts` isolates the real Discord event/transport binding so SDK no-blind-retry behavior and content-free projection can be tested without login. No new product scope.

Git checkpoints skipped: no repository; no repository created. Staging NOT RUN.
Detailed task checkboxes below remain the original implementation recipe; this progress ledger records actual completion.

## Global Constraints

The following lines are copied verbatim from the approved spec:

- Node.js 24 LTS, TypeScript strict, discord.js 14, better-sqlite3, Vitest
- npm พร้อม package-lock.json; agent เลือกและล็อก patch version ที่รองรับ Node.js 24 ตอน implementation
- หนึ่งโปรเซสต่อ bot/guild configuration เท่านั้น ไม่รองรับหลาย replica หรือ SQLite บน network share
- SQLite อยู่บน persistent local disk, เปิด WAL; การเขียนสถานะสำคัญต้อง commit ก่อนยิง API
- Config: DISCORD_TOKEN, GUILD_ID, TRAP_CHANNEL_ID, DATABASE_PATH, LOG_LEVEL
- Discord intents: Guilds และ GuildMessages; ไม่ต้องเปิด MessageContent เพราะไม่ใช้เนื้อหา
- สิทธิ์: ViewChannel ในห้องดัก และ BanMembers ใน guild; วาง role บอทเหนือ role เป้าหมาย
- ใช้ official bot token เท่านั้น ไม่ใช้ user token หรือ self-bot
- ไม่มี allowlist สมาชิก, role หรือทีมงาน สมาชิกบอทอื่นเข้าเงื่อนไขเช่นกันถ้าเป็นข้อความของสมาชิกจริง
- ไม่รวม thread ใต้ห้องดัก เพราะ channelId ต่างกัน
- ไม่ย้อนหลังสแกนข้อความที่ส่งระหว่างบอท offline; Gateway resume อาจส่งบาง event ซ้ำได้ จึงต้องกันงานซ้ำ
- ห้ามใช้ recovery แบบ “ปลดแบนทุกคนที่มีงานค้าง” โดยไม่มี ownership check
- ห้ามทดสอบ destructive behavior ใน production guild โดยไม่ได้รับอนุญาตชัดเจน

Additional implementation decisions, consistent with the spec:

- `deleteMessageSeconds` is always `604800`. Never use deprecated `deleteMessageDays`.
- IDs remain strings. Timestamps are Unix milliseconds. Inject clock/randomness for tests.
- One in-flight worker job; finish its unban attempt before selecting another job. Wake on events, otherwise poll at most every second. No fixed delay between successful ban and unban.
- `manual_review` holds a per-user lock; only `completed` and `failed` release it. A manual-review job is never auto-executed.
- Record *every accepted message ID*, including messages coalesced into an existing job, so replay after completion cannot cause a second ban.
- A job is not proof that the current ban belongs to this bot. Only an exact reason marker match permits unban. A null reason is not a match.
- No dashboard, slash commands, embed, trap-room auto-post, kick counter, full-history crawler, role allowlist, audit-log dependency, or multi-instance support.
- This folder initially contains only planning docs and is not a Git repository. Do not create or modify a parent repository. Commit checkpoints below apply only after the user authorizes a repo or supplies one; otherwise record checkpoints without committing. Do not deploy or request a real token to run tests.

## File Map

| File | Responsibility |
|---|---|
| `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts` | Runtime/test toolchain |
| `.gitignore`, `.env.example` | Secret and local database exclusion; safe config example |
| `src/config.ts`, `src/logger.ts` | Environment validation; structured redacted output |
| `src/contracts.ts` | Shared explicit domain interfaces below |
| `src/db.ts`, `src/jobs.ts` | Schema, transactions, durable job repository |
| `src/discord-adapter.ts` | Fresh REST state, permissions, typed failures |
| `src/trap-handler.ts` | Narrow event filtering and durable ingestion |
| `src/softban-worker.ts` | Ownership-checked state machine and recovery |
| `src/scheduler.ts` | Serial execution, due times, alert checks, stop/drain |
| `src/app.ts`, `src/index.ts` | Testable lifecycle and thin process entry point |
| `tests/helpers.ts` | Real temporary SQLite + fake remote adapter fixtures |
| `tests/config.test.ts`, `tests/logger.test.ts` | Boot/config and secret tests |
| `tests/jobs.test.ts`, `tests/discord-adapter.test.ts` | Persistence and API contracts |
| `tests/trap-handler.test.ts`, `tests/softban-worker.test.ts` | Trigger rules and state machine |
| `tests/recovery.test.ts`, `tests/scheduler.test.ts`, `tests/app.test.ts` | Failure boundaries and lifecycle |
| `README.md` | Setup, limitations, Windows operation, manual recovery and staging checklist |

Small `contracts.ts`, `scheduler.ts`, and `app.ts` files are deliberate splits of the spec's worker/entry-point responsibilities. They are not new product scope.

## Locked Interfaces

Create these definitions in Task 2. Later tasks consume them without renaming methods. Implementation-private helpers may be added locally.

```ts
// src/contracts.ts
export type State = 'queued' | 'banning' | 'unbanning' |
  'completed' | 'failed' | 'manual_review';
export type Ownership = 'unchecked' | 'matched' | 'absent' | 'foreign' | 'unknown';
export interface Trigger {
  guildId: string; channelId: string; userId: string; messageId: string;
}
export interface Job extends Trigger {
  id: string; reason: string; state: State; ownership: Ownership;
  createdAt: number; updatedAt: number; banStartedAt: number | null;
  attempts: number; nextAttemptAt: number; lastError: string | null;
  lastAlertAt: number | null;
}
export type JobPatch = Partial<Pick<Job,
  'state' | 'ownership' | 'banStartedAt' | 'attempts' |
  'nextAttemptAt' | 'lastError' | 'lastAlertAt'>>;
export interface Jobs {
  accept(trigger: Trigger, now: number): {
    kind: 'created' | 'coalesced' | 'duplicate'; job: Job;
  };
  get(id: string): Job;
  change(id: string, expected: State, patch: JobPatch, now: number): Job;
  nextDue(now: number): Job | null;
  recoverable(): Job[];
  overdue(now: number): Job[];
}
export type FailureKind = 'transient' | 'permanent';
export class ApiFailure extends Error {
  constructor(public readonly kind: FailureKind, public readonly code: string) {
    super(code);
  }
}
export interface DiscordPort {
  preflight(guildId: string, channelId: string): Promise<void>;
  canBan(guildId: string, userId: string): Promise<void>;
  getBan(guildId: string, userId: string): Promise<{ reason: string | null } | null>;
  ban(guildId: string, userId: string, reason: string): Promise<void>;
  unban(guildId: string, userId: string, reason: string): Promise<void>;
}
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical';
export type LogFields = Partial<{
  jobId: string; guildId: string; channelId: string; userId: string;
  state: State; errorCode: string; retryAt: number;
}>;
export interface Log { emit(level: LogLevel, event: string, fields?: LogFields): void }
export interface Clock { now(): number; random(): number }
export interface Worker {
  run(job: Job): Promise<void>;
  checkAlerts(): void;
}
export interface Scheduler {
  start(): void;
  wake(): void;
  stop(timeoutMs: number): Promise<boolean>; // true only if drained
}
```

All database errors throw; do not convert them to `ApiFailure`. `ApiFailure` codes are sanitized stable identifiers, not raw request messages. `onFatal` synchronously disables intake and new scheduling, then asynchronously waits for the active worker to settle before exit. It returns void immediately; the worker must not await scheduler drain from inside itself. Call it once at the start of the storage-failure handler, then finish any bounded emergency cleanup before returning from `run`.

## Task 1: Runnable Toolchain, Validated Config, Safe Logs

**Files:** Create `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `.gitignore`, `src/config.ts`, `src/logger.ts`, `tests/config.test.ts`, `tests/logger.test.ts`.

**Interfaces:** Produce `readConfig(env: NodeJS.ProcessEnv): Config` and `createLogger(level: LogLevel, secrets: string[], sink?: (line: string) => void): Log`. `Config` contains `token`, `guildId`, `trapChannelId`, `databasePath`, `logLevel`; all strings except the narrowed log level. Import `Log` types from the locked contracts when Task 2 lands; until then keep these three log types in `logger.ts` and move/re-export them in Task 2 without changing signatures.

- [ ] **1. Check Node and select compatible dependencies.** Run `node --version` and `npm --version`. Require Node 24.x for this project. Inspect `npm view discord.js@14 engines` and `npm view better-sqlite3 engines`. Install dependencies with `--save-exact`, and keep the generated lockfile. Do not invent exact available patch versions in advance.

```bash
npm init -y
npm install --save-exact discord.js@14 better-sqlite3
npm install --save-dev --save-exact typescript vitest @types/node@24 @types/better-sqlite3
```

Set `private: true`, `type: "module"`, `engines: {"node": ">=24 <25"}`. Scripts:

```json
{
  "dev": "npm run build && npm start",
  "build": "tsc -p tsconfig.json",
  "typecheck": "tsc -p tsconfig.json --noEmit && tsc --noEmit --strict --skipLibCheck --target ES2023 --module NodeNext --moduleResolution NodeNext --types node tests/*.ts vitest.config.ts",
  "test": "vitest run",
  "test:watch": "vitest",
  "start": "node --env-file=.env dist/index.js"
}
```

Use `.js` extensions in TypeScript relative imports for compiled Node ESM. The dev script compiles first; do not run these sources with native strip-types, which does not resolve `.js` imports to `.ts` source and cannot strip parameter properties.

`tsconfig.json`: `target: ES2023`, `module: NodeNext`, `moduleResolution: NodeNext`, `strict: true`, `esModuleInterop: true`, `skipLibCheck: true`, `rootDir: src`, `outDir: dist`, `sourceMap: true`, include `src/**/*.ts`. `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['tests/**/*.test.ts'] } });
```

- [ ] **2. Add failing tests before config/logger implementation.**

```ts
// tests/config.test.ts
import { expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
const valid = {
  DISCORD_TOKEN: 'test-secret', GUILD_ID: '111111111111111111',
  TRAP_CHANNEL_ID: '222222222222222222', DATABASE_PATH: './data/jobs.sqlite',
  LOG_LEVEL: 'info',
};
it('reads explicit config', () => {
  expect(readConfig(valid)).toMatchObject({
    guildId: valid.GUILD_ID, trapChannelId: valid.TRAP_CHANNEL_ID,
    databasePath: './data/jobs.sqlite', logLevel: 'info',
  });
});
it.each(['', 'abc', '-1', '123'])('rejects invalid guild ID %s', value => {
  expect(() => readConfig({ ...valid, GUILD_ID: value })).toThrow('GUILD_ID');
});
it('rejects missing token without exposing a token', () => {
  expect(() => readConfig({ ...valid, DISCORD_TOKEN: '' })).toThrow('DISCORD_TOKEN');
});
it('rejects ephemeral storage and invalid log level', () => {
  expect(() => readConfig({ ...valid, DATABASE_PATH: ':memory:' })).toThrow('DATABASE_PATH');
  expect(() => readConfig({ ...valid, LOG_LEVEL: 'verbose' })).toThrow('LOG_LEVEL');
});
```

```ts
// tests/logger.test.ts
import { expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';
it('redacts secrets and emits parseable JSON', () => {
  const lines: string[] = [];
  const log = createLogger('info', ['test-secret'], line => lines.push(line));
  log.emit('error', 'api_failed', { errorCode: 'test-secret' });
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain('test-secret');
  expect(JSON.parse(lines[0])).toMatchObject({ level: 'error', event: 'api_failed' });
});
it('filters below configured level', () => {
  const lines: string[] = [];
  createLogger('warn', [], line => lines.push(line)).emit('info', 'ready');
  expect(lines).toEqual([]);
});
```

- [ ] **3. Run RED:** `npm test -- tests/config.test.ts tests/logger.test.ts`. Expect missing module/export failure.
- [ ] **4. Implement validation and JSON logging.** Use these exact validation rules:

```ts
const snowflake = /^[1-9]\d{16,19}$/;
// Validate both IDs with regex AND BigInt(value) <= 18446744073709551615n.
// token: required after trim; never put original input in thrown errors.
// databasePath: default './data/jobs.sqlite'; reject blank, ':memory:', 'file:' URI,
// and obvious network paths beginning '\\\\' or '//'. Local disk remains an ops rule.
// logLevel: default 'info', one of debug/info/warn/error/critical.
```

Logger emits one JSON object per line with ISO timestamp, level, event, and only whitelisted `LogFields`. Redact nonempty secret strings in string values *before* JSON encoding. Never serialize raw errors, Discord objects, environment, HTTP headers, message content or attachments. Level ranks: debug 10, info 20, warn 30, error 40, critical 50. Default sink is `process.stdout.write(line + '\n')`.

`.env.example` must contain blank token/IDs and `DATABASE_PATH=./data/jobs.sqlite`, `LOG_LEVEL=info`; no working credentials. `.gitignore` excludes `.env`, `.env.*` except `.env.example`, `node_modules/`, `dist/`, `coverage/`, `data/`, `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`.

- [ ] **5. Run GREEN:** `npm test -- tests/config.test.ts tests/logger.test.ts` and `npm run typecheck` and `npm run build`. Also add boundary tests for all missing IDs, maximum unsigned snowflake, blank path and default values before closing this task.
- [ ] **6. Checkpoint:** `git add package.json package-lock.json tsconfig.json vitest.config.ts .env.example .gitignore src/config.ts src/logger.ts tests/config.test.ts tests/logger.test.ts && git commit -m "chore: bootstrap tested softban runtime"` if Git is authorized/available.

## Task 2: Durable Queue and Event Deduplication

**Files:** Create `src/contracts.ts`, `src/db.ts`, `src/jobs.ts`, `tests/jobs.test.ts`; modify `src/logger.ts` to import/re-export shared log types.

**Interfaces:** Consume locked contracts. Produce `openDatabase(path: string, scope: { guildId: string; channelId: string }): Database.Database` and `createJobs(db: Database.Database): Jobs`, using the `better-sqlite3` type namespace. Opening creates parent directories except the test-only `:memory:` path. Closing is `db.close()`.

- [ ] **1. Write failing persistence tests.**

```ts
// tests/jobs.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createJobs } from '../src/jobs.js';
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
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
it('manual review retains the per-user lock', () => {
  const db = openDatabase(':memory:', scope);
  try {
    const jobs = createJobs(db);
    const { job } = jobs.accept(trigger, 1);
    jobs.change(job.id, 'queued', { state: 'manual_review' }, 2);
    expect(jobs.accept({ ...trigger, messageId: '555555555555555555' }, 3).kind).toBe('coalesced');
    expect(jobs.nextDue(999)).toBeNull();
  } finally { db.close(); }
});
```

- [ ] **2. Run RED:** `npm test -- tests/jobs.test.ts`. Expect missing modules.
- [ ] **3. Implement schema and repository transactions.** Schema version 1:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS scope (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  guildId TEXT NOT NULL, channelId TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, guildId TEXT NOT NULL, channelId TEXT NOT NULL,
  userId TEXT NOT NULL, messageId TEXT NOT NULL,
  reason TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('queued','banning','unbanning','completed','failed','manual_review')),
  ownership TEXT NOT NULL CHECK(ownership IN ('unchecked','matched','absent','foreign','unknown')),
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
  banStartedAt INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  nextAttemptAt INTEGER NOT NULL, lastError TEXT, lastAlertAt INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_user_lock ON jobs(guildId, userId)
  WHERE state IN ('queued','banning','unbanning','manual_review');
CREATE TABLE IF NOT EXISTS seen_messages (
  guildId TEXT NOT NULL, messageId TEXT NOT NULL,
  jobId TEXT NOT NULL REFERENCES jobs(id), receivedAt INTEGER NOT NULL,
  PRIMARY KEY(guildId, messageId)
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state, nextAttemptAt);
PRAGMA user_version = 1;
```

Wrap initial migration and scope binding in a transaction; read `user_version` before migration and reject a newer version. Compare stored scope to requested scope on every open. Mismatch fails boot without running recovery against a different guild/channel. Do not overwrite the stored scope.

`accept` runs one transaction: check seen ID first; otherwise find per-user locked job, create one if none (`randomUUID()`, reason `trap-softban:${id}`, queued, unchecked, timestamps now, attempts 0), then insert seen ID referencing that job. Return duplicate/coalesced/created. No cleanup of seen IDs in this release; document disk growth.

`change` accepts only typed patch columns via a hardcoded column whitelist. Update with `WHERE id=? AND state=?`, require exactly one changed row, set updatedAt and return refreshed job. Transition graph permits same-state retry/metadata updates plus:

```text
queued -> banning | failed | manual_review
banning -> unbanning | failed | manual_review
unbanning -> completed | manual_review
manual_review -> completed | failed   (operator-only, never worker)
completed, failed -> no further state change
```

`nextDue` excludes terminal/manual-review rows and uses `nextAttemptAt <= now`, prioritizing unbanning, then banning, then queued, then oldest createdAt/id. `recoverable` returns all queued/banning/unbanning rows in that priority order even when future-due; startup must load them but respect their due times. `overdue` returns banning/unbanning/manual_review rows with non-null banStartedAt aged >=60000ms and lastAlertAt null or >=300000ms ago. Return immutable snapshots, not an in-memory mutable source of truth.

- [ ] **4. Add tests for scope mismatch, unknown schema, persisted retry metadata, wrong expected state, illegal transition, due-time filtering, priority, transaction rollback, and message-ID replay after `completed` (use legal transitions).** For each test, construct the row via `accept` and `change`, not application SQL writes. Add a test that 20 different message IDs for one user still produce one recoverable job and all IDs remain duplicates after completion.
- [ ] **5. Run GREEN:** `npm test -- tests/jobs.test.ts && npm run typecheck && npm run build`.
- [ ] **6. Checkpoint:** `git add src/contracts.ts src/logger.ts src/db.ts src/jobs.ts tests/jobs.test.ts && git commit -m "feat: persist softban jobs and message deduplication"` when Git is available.

## Task 3: Discord Adapter with Fresh Ownership Evidence

**Files:** Create `src/discord-adapter.ts`, `tests/discord-adapter.test.ts`.

**Interfaces:** Produce `createDiscordAdapter(client: Client): DiscordPort` and `normalizeApiError(error: unknown): ApiFailure`. Consume `DiscordPort`/`ApiFailure`. Accept `Client` from discord.js. Tests pass a narrowly shaped fake cast to Client at the adapter boundary only.

- [ ] **1. Write failing adapter tests.** This test fixes the destructive request shape:

```ts
// tests/discord-adapter.test.ts
import { expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import { createDiscordAdapter } from '../src/discord-adapter.js';
it('uses exactly seven days and reason marker on ban', async () => {
  const create = vi.fn().mockResolvedValue(undefined);
  const client = { guilds: { fetch: vi.fn().mockResolvedValue({ bans: { create } }) } };
  await createDiscordAdapter(client as unknown as Client).ban('g', 'u', 'trap-softban:job');
  expect(create).toHaveBeenCalledExactlyOnceWith('u', {
    deleteMessageSeconds: 604800, reason: 'trap-softban:job',
  });
});
it('only Unknown Ban becomes null', async () => {
  const fetch = vi.fn().mockRejectedValue({ code: 10026, status: 404 });
  const client = { guilds: { fetch: vi.fn().mockResolvedValue({ bans: { fetch } }) } };
  const api = createDiscordAdapter(client as unknown as Client);
  expect(await api.getBan('g', 'u')).toBeNull();
  fetch.mockRejectedValue({ code: 50013, status: 403 });
  await expect(api.getBan('g', 'u')).rejects.toMatchObject({ kind: 'permanent', code: '50013' });
});
```

- [ ] **2. Run RED:** `npm test -- tests/discord-adapter.test.ts`.
- [ ] **3. Implement using current discord.js 14 documented signatures.** Verify installed type declarations for `guild.bans.fetch({user, force: true})`, `guild.members.fetch({user, force: true})`, and REST retry options before writing calls. Never use cached bans as ownership evidence.

```ts
// Request core inside adapter methods; surround with error normalization.
await guild.bans.create(userId, { deleteMessageSeconds: 604800, reason });
await guild.bans.remove(userId, reason);
const record = await guild.bans.fetch({ user: userId, force: true });
return { reason: record.reason };
```

`getBan`: only Discord code 10026 returns null. Permission, unknown guild, timeout, 5xx and other 404s throw. `unban`: only 10026 is accepted as success; never swallow permission errors.

`canBan`: fetch guild, self member and target member freshly; fail `OWNER` for guild owner, `50013` if no BanMembers, `HIERARCHY` if self highest role comparePositionTo(target highest) <= 0 or target is not bannable. Fetch the individual target, not the full member list; no GuildMembers intent. Unknown Member is permanent `10007`, not a reason to skip checks and ban by guess. Do not exempt targets with Administrator or bot=true.

`preflight`: fetch guild and configured channel, confirm matching guild and `ChannelType.GuildText`; fetch self member and check BanMembers and channel `ViewChannel`. Fail with stable `SCOPE_MISMATCH`, `CHANNEL_TYPE`, `50013` as appropriate. Do not require Administrator, ManageMessages, SendMessages or ViewAuditLog. Runtime permissions can still change after preflight.

`normalizeApiError`: retain ApiFailure; transient for network codes `ECONNRESET`, `ECONNREFUSED`, `EAI_AGAIN`, `ENOTFOUND`, `ETIMEDOUT`, undici timeout/socket codes, AbortError and HTTP 5xx. For surfaced 429 use transient `RATE_LIMIT`; normally discord.js handles it. Map other HTTP 4xx/Discord validation errors permanent using numeric Discord code or `HTTP_<status>`. Unknown non-HTTP errors map permanent `UNCLASSIFIED_API_ERROR` and are visible; never serialize raw request error objects. Worker decides ambiguity by its durable phase, not merely failure class.

- [ ] **4. Add tests for fresh `force: true`, nullable reason preservation, unban 10026 versus 403, preflight wrong guild/type/missing permissions, owner/equal/lower/higher roles, another bot target, individual-member lookup, network/5xx classification and sanitized unknown errors.**
- [ ] **5. Run GREEN:** `npm test -- tests/discord-adapter.test.ts && npm run typecheck && npm run build`.
- [ ] **6. Checkpoint:** `git add src/discord-adapter.ts tests/discord-adapter.test.ts && git commit -m "feat: add ownership-aware Discord adapter"` when Git is available.

## Task 4: Exact-Scope Message Intake

**Files:** Create `src/trap-handler.ts`, `tests/trap-handler.test.ts`.

**Interfaces:** Consume Config, Jobs, Log and Clock. Produce the following:

```ts
export interface MessageEnvelope {
  id: string; guildId: string | null; channelId: string;
  authorId: string; webhookId: string | null; system: boolean;
}
export function createTrapHandler(deps: {
  guildId: string; channelId: string; selfId: string;
  jobs: Jobs; clock: Clock; log: Log; wake: () => void;
  onFatal: (error: unknown) => void;
}): { handle(message: MessageEnvelope): void; setEnabled(value: boolean): void };
```

No `content`, `author.bot`, role exemptions or attachment inspection is present in the decision interface. Initial enabled state is false.

- [ ] **1. Write failing filter tests.**

```ts
// tests/trap-handler.test.ts
import { expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createJobs } from '../src/jobs.js';
import { createTrapHandler } from '../src/trap-handler.js';
const scope = { guildId: 'g', channelId: 'c' };
it('ignores out-of-scope, self, webhook and system events', () => {
  const db = openDatabase(':memory:', scope);
  try {
    const jobs = createJobs(db);
    const wake = vi.fn();
    const handler = createTrapHandler({ ...scope, selfId: 'self', jobs,
      clock: { now: () => 10, random: () => 0 }, log: { emit: vi.fn() },
      wake, onFatal: vi.fn() });
    handler.setEnabled(true);
    const m = { id: 'm', ...scope, authorId: 'u', webhookId: null, system: false };
    for (const patch of [{ guildId: null }, { guildId: 'other' },
      { channelId: 'thread' }, { authorId: 'self' }, { webhookId: 'w' }, { system: true }]) {
      handler.handle({ ...m, ...patch });
    }
    expect(jobs.recoverable()).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
    handler.handle(m);
    expect(jobs.recoverable()).toHaveLength(1);
    expect(wake).toHaveBeenCalledOnce();
  } finally { db.close(); }
});
```

- [ ] **2. Run RED:** `npm test -- tests/trap-handler.test.ts`.
- [ ] **3. Implement the filter and persistence-first handler.**

```ts
if (!enabled || message.guildId !== deps.guildId ||
    message.channelId !== deps.channelId || message.authorId === deps.selfId ||
    message.webhookId !== null || message.system) return;
try {
  const accepted = deps.jobs.accept({
    guildId: message.guildId, channelId: message.channelId,
    userId: message.authorId, messageId: message.id,
  }, deps.clock.now());
  deps.log.emit('info', `trigger_${accepted.kind}`, {
    jobId: accepted.job.id, guildId: message.guildId,
    channelId: message.channelId, userId: message.authorId,
  });
  deps.wake();
} catch (error) {
  enabled = false;
  deps.log.emit('critical', 'intake_storage_failure', { errorCode: 'DATABASE_FAILURE' });
  deps.onFatal(error);
}
```

- [ ] **4. Add tests for initially disabled intake, re-disable, duplicate/coalesced events, persistence failure (no wake), and text/attachment/sticker envelopes all taking the same path.** In lifecycle tests assert another bot's `Message.author.bot=true` does not prevent conversion into a normal envelope.
- [ ] **5. Run GREEN:** `npm test -- tests/trap-handler.test.ts && npm run typecheck && npm run build`.
- [ ] **6. Checkpoint:** `git add src/trap-handler.ts tests/trap-handler.test.ts && git commit -m "feat: enqueue messages from the exact trap channel"` when Git is available.

## Task 5: Softban State Machine and Durable Retries

**Files:** Create `src/softban-worker.ts`, `tests/helpers.ts`, `tests/softban-worker.test.ts`.

**Interfaces:** Produce `createWorker(deps: { jobs: Jobs; api: DiscordPort; clock: Clock; log: Log; onFatal: (error: unknown) => void }): Worker` and `retryDelay(attempt: number, random: number): number`. `attempt` is 1-based. Consume locked interfaces only, not Discord Client or SQLite directly.

- [ ] **1. Build this test fixture, then write happy-path and retry tests.** It models remote state separately from the database so crash tests can keep the remote state alive.

```ts
// tests/helpers.ts
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
  let db = openDatabase(path, scope);
  let jobs = createJobs(db);
  const remote = new Map<string, { reason: string | null }>();
  const calls: string[] = [];
  const api = {
    preflight: vi.fn<DiscordPort['preflight']>().mockResolvedValue(undefined),
    canBan: vi.fn<DiscordPort['canBan']>().mockResolvedValue(undefined),
    getBan: vi.fn<DiscordPort['getBan']>().mockImplementation(async (_g, u) => remote.get(u) ?? null),
    ban: vi.fn<DiscordPort['ban']>().mockImplementation(async (_g, u, reason) => {
      calls.push('ban'); remote.set(u, { reason });
    }),
    unban: vi.fn<DiscordPort['unban']>().mockImplementation(async (_g, u) => {
      calls.push('unban'); remote.delete(u);
    }),
  };
  let now = 1000;
  const clock = { now: () => now, random: () => 0 };
  const log = { emit: vi.fn() };
  const onFatal = vi.fn();
  return {
    get jobs() { return jobs; }, api, remote, calls, clock, log, onFatal,
    advance(ms: number) { now += ms; },
    makeWorker() { return createWorker({ jobs, api, clock, log, onFatal }); },
    enqueue(messageId = 'm', userId = 'u') {
      return jobs.accept({ ...scope, messageId, userId }, now).job;
    },
    reopen() { db.close(); db = openDatabase(path, scope); jobs = createJobs(db); },
    close() { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
```

```ts
// tests/softban-worker.test.ts
import { expect, it } from 'vitest';
import { ApiFailure } from '../src/contracts.js';
import { retryDelay } from '../src/softban-worker.js';
import { fixture } from './helpers.js';
it('bans then unbans without waiting', async () => {
  const f = fixture();
  try {
    const job = f.enqueue();
    await f.makeWorker().run(job);
    expect(f.calls).toEqual(['ban', 'unban']);
    expect(f.jobs.get(job.id).state).toBe('completed');
    expect(f.remote.has('u')).toBe(false);
    expect(f.clock.now()).toBe(1000);
  } finally { f.close(); }
});
it('keeps failed unban durable and retries without a second ban', async () => {
  const f = fixture();
  try {
    f.api.unban.mockRejectedValueOnce(new ApiFailure('transient', 'ETIMEDOUT'));
    const job = f.enqueue();
    const worker = f.makeWorker();
    await worker.run(job);
    expect(f.jobs.get(job.id)).toMatchObject({ state: 'unbanning', attempts: 1, nextAttemptAt: 2000 });
    f.advance(1000);
    await worker.run(f.jobs.get(job.id));
    expect(f.api.ban).toHaveBeenCalledOnce();
    expect(f.jobs.get(job.id).state).toBe('completed');
  } finally { f.close(); }
});
it('has capped exponential jittered retry', () => {
  expect(retryDelay(1, 0)).toBe(1000);
  expect(retryDelay(2, 0)).toBe(2000);
  expect(retryDelay(30, 1)).toBe(60000);
});
```

- [ ] **2. Run RED:** `npm test -- tests/softban-worker.test.ts`.
- [ ] **3. Implement retry math and state machine, using the full decision table below.**

```ts
export function retryDelay(attempt: number, random: number): number {
  const base = Math.min(60000, 1000 * 2 ** Math.min(16, Math.max(0, attempt - 1)));
  return Math.min(60000, Math.round(base * (1 + Math.max(0, Math.min(1, random)) * 0.2)));
}
```

At run entry, refetch `jobs.get(job.id)` and return for future-due or terminal/manual-review. Catch API failures only around API operations; let repository failures reach a separate outer storage-failure handler. Do not wrap database calls inside an API-error catch. Persist state before issuing its destructive request. Keep a local `ownedBanMayExist` flag from successful ban or matched ownership; it enables bounded emergency cleanup when persistence fails.

| Durable phase / event | Required action |
|---|---|
| queued | `getBan` first; an existing ban => failed + `PREEXISTING_BAN`, no unban. Otherwise `canBan`, then persist banning with banStartedAt=now, attempts=0 and nextAttemptAt=now, then issue ban exactly once. |
| queued fetch/check transient | Keep queued, increment attempts, persist nextAttemptAt=now+retryDelay; no ban. |
| queued fetch/check permanent | failed, sanitized error code; no ban/unban. |
| ban resolved | Set local ownedBanMayExist; persist unbanning, attempts=0, nextAttemptAt=now. Continue immediately to fresh ownership check. |
| ban threw known definitive 4xx rejection (permission/hierarchy/invalid user/validation) | failed with error. Never unban. Only classify definitive Discord HTTP rejections this way, not arbitrary unknown errors. |
| ban timeout/5xx/unknown or surfaced rate limit | Keep banning; reconcile fresh ban immediately if connection permits. No repeat ban. Unknown adapter errors after dispatch are ambiguous, not definitive rejection. |
| banning on restart/retry | Fetch ban. Exact reason => record matched, transition unbanning, continue. No ban => manual_review, ownership absent, `AMBIGUOUS_BAN_ABSENT`. Foreign/null reason => manual_review, ownership foreign/unknown. |
| unbanning | Fetch current ban freshly. Exact reason => record matched before unban. No ban => completed with ownership absent. Foreign/null reason => manual_review; never unban. |
| unban resolved or adapter accepted 10026 | completed; reset attempts/lastError. |
| fetch/unban transient in banning or unbanning | Retain phase, attempts+1, due time persisted. No retry limit. |
| fetch/unban permanent in banning or unbanning | manual_review and error log, because ban may remain. |
| repository failure before ban | No new destructive call; critical log and onFatal. |
| repository failure after a known successful/owned ban | Call onFatal once to disable intake/new scheduling and request asynchronous drain; attempt a fresh getBan and unban only if marker matches, with <=10s total emergency budget; return from run so drain can finish and exit. Do not call ban again. Do not pretend the completed state was persisted. |

Within one `run`, transition from queued to banning to unbanning to completed without scheduling delay. On ambiguous ban outcome, reconciliation may immediately unban if owned. If the exact ban marker cannot be established, stop automatically and report manual review, even though that can leave a user banned. This is intentionally safer than undoing an administrator's ban.

Bound emergency work to 10s with a local deadline; check the deadline after getBan and before issuing unban. The fixed DiscordPort interface has no AbortSignal, so do not claim cancellation. A deadline race may trigger exit but must never start an overlapping request or let a late getBan continuation issue unban after expiry. On deadline expiry call no more API operations; the already-requested lifecycle drain/15s termination budget is authoritative. A request still in flight requires process termination, not database closure while its continuation may write.

`checkAlerts`: for each `jobs.overdue(now)`, emit `error` event `softban_unresolved` with job identifiers/state/lastError, then persist `lastAlertAt=now` via same-state change. Persist this timestamp so restarts do not create an alert flood. Transition into manual_review always emits its own immediate error event. All completions/failures emit structured results, not message payloads.

- [ ] **4. Add table-driven tests for every row above.** Required assertions include no unban for a pre-existing ban, foreign/null marker, owner/hierarchy error; no re-ban for ambiguous outcomes; unban proceeds only after fresh matched marker; unknown error after dispatch is manual-review/reconcile rather than assumed failed. Test 100 consecutive transient unban failures without dropping the job. Test lastAlertAt throttling across restart.
- [ ] **5. Run GREEN:** `npm test -- tests/softban-worker.test.ts && npm run typecheck && npm run build`.
- [ ] **6. Checkpoint:** `git add src/softban-worker.ts tests/helpers.ts tests/softban-worker.test.ts && git commit -m "feat: implement durable ownership-checked softban workflow"` when Git is available.

## Task 6: Crash Boundaries and Database-Failure Safety

**Files:** Create `tests/recovery.test.ts`; modify `src/softban-worker.ts`/`src/jobs.ts` only for failures demonstrated by these tests.

**Interfaces:** Consume fixture, createWorker, Jobs.change and DiscordPort. Produce regression coverage, not another runtime API. Simulated restart keeps fixture.remote but reopens the same SQLite file.

- [ ] **1. Write recovery tests before any fixes.**

```ts
// tests/recovery.test.ts
import { expect, it } from 'vitest';
import { fixture } from './helpers.js';
it('recovers ban success before the unbanning write', async () => {
  const f = fixture();
  try {
    const job = f.enqueue();
    f.jobs.change(job.id, 'queued', { state: 'banning', banStartedAt: f.clock.now() }, f.clock.now());
    f.remote.set('u', { reason: job.reason }); // remote success; local acknowledgement lost
    f.reopen();
    await f.makeWorker().run(f.jobs.get(job.id));
    expect(f.api.ban).not.toHaveBeenCalled();
    expect(f.api.unban).toHaveBeenCalledOnce();
    expect(f.jobs.get(job.id).state).toBe('completed');
  } finally { f.close(); }
});
it('recovers lost unban acknowledgement without re-banning', async () => {
  const f = fixture();
  try {
    const job = f.enqueue();
    f.jobs.change(job.id, 'queued', { state: 'banning', banStartedAt: f.clock.now() }, f.clock.now());
    f.jobs.change(job.id, 'banning', { state: 'unbanning' }, f.clock.now());
    f.reopen(); // remote is already unbanned
    await f.makeWorker().run(f.jobs.get(job.id));
    expect(f.api.ban).not.toHaveBeenCalled();
    expect(f.api.unban).not.toHaveBeenCalled();
    expect(f.jobs.get(job.id).state).toBe('completed');
  } finally { f.close(); }
});
it('does not guess after banning intent persisted but no ban exists', async () => {
  const f = fixture();
  try {
    const job = f.enqueue();
    f.jobs.change(job.id, 'queued', { state: 'banning', banStartedAt: f.clock.now() }, f.clock.now());
    f.reopen();
    await f.makeWorker().run(f.jobs.get(job.id));
    expect(f.jobs.get(job.id).state).toBe('manual_review');
    expect(f.api.ban).not.toHaveBeenCalled();
    expect(f.api.unban).not.toHaveBeenCalled();
  } finally { f.close(); }
});
```

- [ ] **2. Run tests:** `npm test -- tests/recovery.test.ts`. Existing-correct behavior may already pass; for any new fix first demonstrate the failing test. Never break working code merely to manufacture RED.
- [ ] **3. Complete this boundary matrix as individual tests.**

| Boundary | Durable state | Remote state | Expected after reopen |
|---|---|---|---|
| before queue commit | no row | absent | no action; replay may enqueue |
| after queue commit | queued | absent | normal softban |
| before banning commit, DB throws | queued | absent | no ban sent, fatal |
| after banning commit, before HTTP | banning | absent | manual_review, not re-ban |
| ban accepted, response timeout | banning | matching marker | unban once, completed |
| after ban, before unbanning commit | banning | matching marker | unban once, completed |
| unbanning committed, before unban | unbanning | matching marker | unban once, completed |
| unban accepted, response timeout | unbanning | absent | completed |
| before completed commit | unbanning | absent | completed |
| after completed commit | completed | absent | no API calls |
| admin replaced ban while down | banning/unbanning | different marker | manual_review, no unban |
| lost permission during recovery | banning/unbanning | unreadable | manual_review + error |

Inject database failure with a spy on `jobs.change` for the exact expected transition, not by modifying the worker algorithm. Verify post-ban persist failure attempts ownership-checked emergency unban, records critical log, calls fatal, and does not report persisted completion. For an emergency lookup mismatch or timeout, no blind unban. Fake timers enforce the emergency deadline; settle any mock outstanding promise before fixture cleanup.

- [ ] **4. Implement only regression-driven corrections.** The persistence barrier pattern is:

```ts
// Correct ordering; actual worker variables use these locked names.
job = jobs.change(job.id, 'queued', {
  state: 'banning', banStartedAt: clock.now(), attempts: 0, nextAttemptAt: clock.now(),
}, clock.now());
await api.ban(job.guildId, job.userId, job.reason);
// From here onward storage failure must attempt owned-ban emergency cleanup.
job = jobs.change(job.id, 'banning', {
  state: 'unbanning', attempts: 0, nextAttemptAt: clock.now(),
}, clock.now());
```

Also test failed `accept` transaction leaves neither job nor seen_messages record; restore storage and replay successfully. Do not claim simulation proves disk/power-loss guarantees on all hardware.

- [ ] **5. Run GREEN:** `npm test -- tests/recovery.test.ts tests/softban-worker.test.ts tests/jobs.test.ts && npm run typecheck && npm run build`.
- [ ] **6. Checkpoint:** `git add tests/recovery.test.ts src/softban-worker.ts src/jobs.ts && git commit -m "test: cover softban crash and persistence boundaries"` when Git is available.

## Task 7: Serial Scheduler and Safe Application Lifecycle

**Files:** Create `src/scheduler.ts`, `src/app.ts`, `src/index.ts`, `tests/scheduler.test.ts`, `tests/app.test.ts`; modify logger/config only if a demonstrated integration issue requires it.

**Interfaces:**

```ts
// src/scheduler.ts
export function createScheduler(deps: {
  jobs: Jobs; worker: Worker; clock: Clock; onFatal: (error: unknown) => void;
}): Scheduler;

// src/app.ts
export interface ClientPort {
  selfId(): string; // throws before ready
  login(token: string): Promise<void>;
  destroy(): Promise<void>;
  onReady(fn: () => void): void;
  onMessage(fn: (message: MessageEnvelope) => void): void;
  onConnection(fn: (ready: boolean) => void): void;
  onError(fn: (error: unknown) => void): void;
}
export interface App {
  start(): Promise<void>; // login + first successful preflight, or rejects
  stop(): Promise<boolean>; // false means timed out; caller must exit
}
export function createApp(deps: {
  config: Config; client: ClientPort; api: DiscordPort; jobs: Jobs;
  clock: Clock; log: Log; closeDatabase: () => void;
  exit: (code: number) => void;
}): App;
```

`createApp` owns handler, worker and scheduler construction so its fatal handler can synchronously disable intake, request scheduler stop, then finish orderly exit. `ClientPort` is a lifecycle test seam, not another Discord implementation. Bind it to one real Client inside index.ts.

- [ ] **1. Add scheduler tests.**

```ts
// tests/scheduler.test.ts
import { expect, it, vi } from 'vitest';
import { createScheduler } from '../src/scheduler.js';
import { fixture } from './helpers.js';
it('does not overlap work when wake is repeated', async () => {
  const f = fixture();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const run = vi.fn(async () => { await blocked; });
  const scheduler = createScheduler({ jobs: f.jobs, clock: f.clock,
    worker: { run, checkAlerts: vi.fn() }, onFatal: f.onFatal });
  try {
    f.enqueue();
    scheduler.start();
    scheduler.wake(); scheduler.wake();
    await Promise.resolve(); await Promise.resolve();
    expect(run).toHaveBeenCalledOnce();
    const stopping = scheduler.stop(1000);
    release();
    expect(await stopping).toBe(true);
  } finally { release(); await scheduler.stop(1000); f.close(); }
});
```

Add fake-client application tests with this local helper (no token or network):

```ts
// In tests/app.test.ts; import ClientPort from src/app.ts and MessageEnvelope from handler.
function fakeClient() {
  let ready: () => void = () => {};
  let message: (m: MessageEnvelope) => void = () => {};
  let connection: (v: boolean) => void = () => {};
  let error: (e: unknown) => void = () => {};
  const port: ClientPort = {
    selfId: () => 'self',
    login: vi.fn(async () => { ready(); }), destroy: vi.fn(async () => {}),
    onReady: fn => { ready = fn; }, onMessage: fn => { message = fn; },
    onConnection: fn => { connection = fn; }, onError: fn => { error = fn; },
  };
  return { port, send: (m: MessageEnvelope) => message(m),
    connect: (v: boolean) => connection(v), fail: (e: unknown) => error(e) };
}
```

Create app using `fixture()` jobs/api/clock/log, fakeClient, config `{token:'test',guildId:'g',trapChannelId:'c',databasePath:'unused',logLevel:'info'}`, spy `closeDatabase`, spy `exit`. Test that a held `api.preflight` promise keeps sent messages from reaching jobs; release it and await `app.start()`, then a trap message creates a job. Stop app before closing fixture. Test rejected preflight rejects start and leaves intake disabled.

- [ ] **2. Run RED:** `npm test -- tests/scheduler.test.ts tests/app.test.ts`.
- [ ] **3. Implement serial scheduler.**

```text
start: mark accepting scheduling, install <=1s interval, wake
wake: if stopped return; if draining set wakeRequested and return
      otherwise launch a single async drain with caught errors
 drain: checkAlerts; while not stopped:
          nextDue(clock.now()); if none break
          await worker.run(job)
        release draining flag; honor one pending wake without overlapping
stop: stop new scheduling, clear interval, await current drain for timeoutMs
      return false on timeout; never start another drain
```

Avoid recursive synchronous wake loops and unhandled promises. `worker.run` must either finish the job, park it for review or persist a future due time. Test unbanning priority, future jobs waiting, wake during drain, stop idempotence, delayed remote call, alert checks when no jobs are due and fatal on repository failures.

- [ ] **4. Implement app boot and reconnect policy.** Register event callbacks before login. On first ready: load `jobs.recoverable()` and log recovery count (not raw rows), create/start scheduler before enabling intake, validate preflight, then enable handler and log `ready`. Start recovery once identity is known even if trap channel is missing: lost ViewChannel must not prevent clearing an owned existing ban. Scope and token/config DB validation occurs before login; malformed config does not run API calls. If preflight fails, leave intake off, give recovery a bounded drain via `stop`, then fail startup; unban permission failure becomes manual_review. Startup ready wait has 30s timeout and catches errors.

Reconnect: disable intake on disconnect and log `disconnected`; on ready/resume re-run preflight before enabling, without duplicating worker/handlers. Run recovery on the same REST adapter; transient failures persist retries while Gateway is unavailable. Catch every async event handler rejection.

Shutdown: mark stopping once, disable intake, stop scheduler with 15s budget. If drained, destroy client then close DB exactly once. If timeout, log critical, destroy client and call exit(1) without closing DB underneath pending work; process exit closes its file handles. Fatal storage error disables intake immediately when detected, prevents *new* scheduling and permits the currently running worker's emergency-cleanup budget before final exit. A 10s emergency budget fits within the 15s shutdown budget. Expected SIGINT/SIGTERM uses exit(0) after successful drain; fatal conditions use nonzero.

- [ ] **5. Implement thin index.ts binding.** Verify discord.js installed event names and REST options; use `Events.ClientReady`, `Events.MessageCreate`, shard disconnect/resume events and `Events.Error`. Message projection:

```ts
const envelope: MessageEnvelope = {
  id: message.id, guildId: message.guildId, channelId: message.channelId,
  authorId: message.author.id, webhookId: message.webhookId,
  system: message.system,
};
// Do NOT skip message.author.bot. Own ID and webhook filters live in handler.
```

Instantiate Client with only Guilds and GuildMessages. Set REST `retries: 0` to prevent the library from blindly repeating a 5xx ban; retain built-in 429 queuing and set REST request timeout to 10000ms. Check the chosen discord.js REST implementation does not silently repeat network-failed ban requests; if it does, adjust transport behavior and add a regression test before release. Never promise exactly-once remote effects.

Read config, create logger, open bound DB, build real adapter and ClientPort, then create/start app. Bind signals once. Catch top-level boot errors with sanitized log and exit code 1; token/config errors never print environment. Real `exit` delegates to `process.exit(code)` only after lifecycle drain logic. No imports in testable modules may start the client or read real environment automatically.

- [ ] **6. Run GREEN:** `npm test -- tests/scheduler.test.ts tests/app.test.ts && npm run typecheck && npm run build`. Include integration assertions for self vs another bot, no privileged intents, pending preflight, reconnect gating, recoverable jobs loaded before intake, config scope mismatch before login, failed recovery logging and shutdown with in-flight writes.
- [ ] **7. Checkpoint:** `git add src/scheduler.ts src/app.ts src/index.ts tests/scheduler.test.ts tests/app.test.ts && git commit -m "feat: wire resilient bot lifecycle and serial worker"` when Git is available.

## Task 8: Operator Guide, Full Verification and Handoff

**Files:** Create `README.md`; update `.env.example` only if docs reveal mismatch. No production deployment.

**Interfaces:** Consume actual npm scripts, config and state names. Produce a reproducible operating guide and final verification evidence.

- [ ] **1. Write README with these exact sections and operational content.**

1. Behavior: one exact text channel, all member-authored messages, no team/bot exemption except self, webhook/system excluded, no threads/history scan. Softban is not permanent ban; no automatic re-invite.
2. Hard limits: 604800-second deletion window across this guild only; older history untouched. Gateway offline gaps, latency/rate limits, hierarchy/owner restrictions and eventual Discord deletion. Bot cannot bypass permissions.
3. Requirements: Node 24.x, official bot application, BanMembers + ViewChannel, highest bot role above targets, only Guilds/GuildMessages intents. No MessageContent/GuildMembers privileged toggle needed. Better-sqlite3 needs a compatible native build; if prebuilt install fails on Windows follow package build requirements rather than switching Node versions silently.
4. Install: `npm ci`, copy `.env.example` to `.env`, fill token/IDs, `npm run typecheck`, `npm test`, `npm run build`, `npm start`. Run from project root so `.env` and relative DB path resolve consistently. Token is local only.
5. Deployment: Windows Task Scheduler recipe, restart on failure every 1 minute, do not start a new instance if already running, run whether user is logged on, explicit working directory and absolute `node.exe` path, arguments `--env-file=.env dist/index.js`. Show how to find Node with PowerShell `Get-Command node`. Redirect stdout/stderr to a restricted local log directory using a documented PowerShell launcher; never log `.env`. Do not actually install the scheduled task. Mention sleep/shutdown suspends monitoring.
6. Persistence: one local DB per configured guild/channel, one process, no network share; do not delete DB to clear errors. Stop process before copying DB/WAL/SHM consistently, or use SQLite online backup. Dedup history grows without automatic pruning. Disk full stops new bans. Set external log rotation, disk monitoring and alert forwarding; LOG_LEVEL does not enable Discord-room alerts.
7. Recovery: automatic retry/reconciliation rules; `manual_review` locks this user and needs operator action. Never auto-unban foreign bans or blindly re-ban an ambiguous absent ban. Alert after 60s and at most every 5 minutes thereafter.
8. Manual review runbook: stop bot; use trusted SQLite tooling read-only to inspect job ID/reason/state/error. Check current ban in Discord via an authorized tool that exposes reason. If exact marker owned, unban manually and verify absent. If absent, do not ban again. If foreign/unreadable, coordinate with the moderator and leave ban untouched. Only after that decision, back up DB and mark the job completed (confirmed owned unban/absent) or failed (foreign ban preserved/no further automation). Do not delete seen_messages. Supply transaction below, replacing ID only after checks; never run SQL automatically from the agent.
9. Race warning: Discord lacks compare-and-unban; a moderator can replace a ban between ownership check and removal. Avoid manual moderation of the same user while an active job is running. Matching reason is evidence, not a cryptographic lock. Guarantees are best-effort recovery, not exactly-once API effects.
10. Staging checklist below, and how to read JSON events/error codes. No claim of tested real behavior unless the staging test was actually run with permission.

Manual-review SQL pattern (trusted local operator only):

```sql
BEGIN IMMEDIATE;
SELECT id, guildId, userId, state, reason, ownership, lastError
FROM jobs WHERE id = :verified_job_id;
-- Bind :resolution to 'completed' or 'failed' only after the runbook checks.
UPDATE jobs SET state = :resolution,
  updatedAt = CAST(strftime('%s','now') AS INTEGER) * 1000,
  lastError = 'OPERATOR_RESOLVED'
WHERE id = :verified_job_id AND state = 'manual_review'
  AND :resolution IN ('completed','failed');
SELECT changes(); -- require 1; otherwise ROLLBACK and investigate
COMMIT;
```

- [ ] **2. Run full offline verification from a clean dependency install.**

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Expected: install succeeds on supported Node/OS; all test suites pass; TypeScript exits 0; `dist/index.js` exists. Run production entry with a deliberately incomplete temporary env and verify safe nonzero failure *before login*. Do not use a real `.env` or print credentials to do this. Check `.gitignore` covers the DB sidecars and env; if Git exists, `git check-ignore .env data/jobs.sqlite data/jobs.sqlite-wal` and `git diff --check`.

- [ ] **3. Perform final code review against this matrix.**

| Spec requirement | Implementation/verification |
|---|---|
| softban, seven-day request, no fixed unban delay | Tasks 3, 5 |
| scope, content-free filtering, bots/team, webhook/self/system, threads/offline | Tasks 4, 7, 8 |
| owner/hierarchy/permissions, no privileged intents | Tasks 3, 7 |
| dedup all events, rejoin new message, one locked job | Task 2 |
| scope-bound persistent SQLite, transitions before effects | Tasks 2, 5, 6 |
| ownership, pre-existing bans, ambiguous results, race limitation | Tasks 3, 5, 6, 8 |
| retries/rate limits, no blind ban retry, alert throttling | Tasks 3, 5, 7 |
| disk failures, emergency unban, shutdown/restart | Tasks 5, 6, 7 |
| startup/reconnect health and logs without secrets | Tasks 1, 7, 8 |
| Windows deployment, single instance, persistent disk | Task 8 |
| mocked tests + explicitly authorized staging only | Tasks 1–8 |

Review unsafe paths specifically: generic catch that unbans, ban retry hidden in SDK, cached ownership, automatic `manual_review` replay, dropping a failed-unban job, closing DB during pending work, whole message serialization, and coalesced IDs not recorded. Reject delivery if any remain.

- [ ] **4. Optional staging test — wait for explicit permission and a disposable guild/member.** With the bot role configured, send test-member messages in another room, then a message/file/sticker in the trap room. Verify the member is removed, their ban entry disappears, recent messages across the guild are deleted by Discord and invite rejoin works. Test another bot only with a disposable bot, not production integrations. Test hierarchy failure with a disposable role and confirm logged failure. Observe logs for job identity and completion. Do not claim deletion of >7-day messages. If permission/token is unavailable, mark staging **NOT RUN**; offline tests can still pass.
- [ ] **5. Checkpoint:** `git add README.md .env.example && git commit -m "docs: document softban operations and safety limits"` when Git is available.
- [ ] **6. Deliver summary:** list files, commands actually run and results, staging status, remaining limitations and manual-review handling. No “production ready” claim without deployment evidence. Never include token values.

## Execution Order and Agent Handoff

Do Tasks 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Tasks 3 and 4 could run independently after Task 2, but sequential execution is the default: no need for parallel edits on shared contracts. Review each task before proceeding; write tests first, demonstrate RED for new behavior, implement, verify GREEN. Use an isolated worktree only if a Git repository exists and the user's workflow permits it.

Copy this prompt to the implementing agent:

> อ่าน `docs/superpowers/specs/2026-09-13-discord-trap-softban-design.md` และ `docs/superpowers/plans/2026-09-13-discord-trap-softban.md` ให้ครบ แล้วเขียนโค้ดตาม Task 1–8 แบบ TDD ผู้ใช้อนุมัติ spec แล้ว ไม่ต้องถามเรื่อง softban/ยกเว้นทีมงานซ้ำ ห้ามเพิ่ม scope ห้าม deploy หรือทดสอบกับสมาชิกจริงโดยไม่ได้รับอนุญาต ใช้ mock และ SQLite ชั่วคราวใน tests ตรวจ API/types ของ dependency ที่ติดตั้งจริง ถ้าพบข้อขัดแย้งที่กระทบความปลอดภัยของ ban/unban ให้หยุดถาม อย่าเดา ปัจจุบันโฟลเดอร์ยังไม่มี Git repository; อย่าสร้างหรือแก้ parent repo เอง จบแต่ละ task ให้อัปเดต checklist และรายงานผลทดสอบจริง ส่งมอบ README พร้อมข้อจำกัดย้อนหลัง 7 วันและ manual_review runbook

## Plan Self-Review Record

- Requirements mapped in Task 8 matrix; all spec acceptance criteria have assigned tasks.
- Shared identifiers/types fixed in Locked Interfaces; all public constructors declared in their owning tasks.
- All implementation tasks include executable test examples, RED/GREEN commands, implementation rules/code and checkpoint commands.
- No production code, dependencies, credentials or service installation created while writing this plan.
- Staging verification is explicitly separate from offline tests and requires user permission.
