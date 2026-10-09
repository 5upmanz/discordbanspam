# banbot

Discord trap-channel softban bot. Node.js 24, TypeScript, discord.js 14 and local SQLite.

> Destructive moderation: each accepted member message requests a ban with a seven-day message deletion window, then an immediate ownership-checked unban. Use a disposable guild/member for staging. Never test this on production members without explicit permission.

## Behavior

- Watches one **exact guild ID and text-channel ID** via `messageCreate`.
- Text, attachments, stickers and embed-only member messages follow the same path; message content is neither inspected nor logged.
- No staff/role allowlist. Other bots are eligible; the bot itself, webhook and system messages are excluded.
- Threads, other channels/guilds and DMs are excluded. No offline history scan.
- Softban removes the member from the guild. They may rejoin using an invite; this bot does not invite them back.
- One active job per guild/user; every accepted message ID is recorded, including coalesced messages. A new message after completion can create a new job.
- On readiness, publishes a GIF Embed in the trap channel with a disabled `โดนไปแล้ว N ครั้ง` counter button. The bot's own messages never trigger moderation.
- Counts automatically completed softbans, not raw ban requests, unique members, failures or manual-review resolutions. Count and panel message ID persist in SQLite. Checks for count changes every five seconds, edits the same message, and checks for deletion once per minute. Deleted panels are recreated; permission/network failures are logged and retried without blocking moderation/recovery.
- A send timeout or a crash between sending a new panel and saving its ID can leave a duplicate panel. Remove stale copies manually; Discord message creation and local SQLite cannot be committed atomically.

## Hard limits

Discord accepts `deleteMessageSeconds=604800` (seven days across this guild). Older messages, DMs and other guilds are untouched. Deletion is eventual, not a guaranteed immediate purge.

Gateway outages can miss events. API latency and rate limits prevent a latency guarantee. Owners and members whose highest role equals/exceeds the bot's cannot be banned. Permissions are never elevated; there is no kick fallback.

**Race warning:** Discord has no atomic compare-and-unban operation. An administrator can replace a ban between a fresh ownership check and removal. Avoid manual moderation of the same user while their job is active. Matching `trap-softban:<jobId>` is evidence, not a cryptographic lock. Recovery is best-effort, not an exactly-once API guarantee.

## Requirements

- Node.js **24.x** (`node --version`), npm.
- Official Discord bot application and token. No self-bot/user token.
- `BanMembers` in the guild; `ViewChannel`, `SendMessages`, `EmbedLinks` and `ReadMessageHistory` in the trap channel.
- Bot's highest role above intended target roles.
- Only `Guilds` and `GuildMessages` intents. No `MessageContent` or `GuildMembers` privileged toggle, Administrator, ManageMessages or ViewAuditLog requirement.
- Persistent **local disk**, one process per configuration. No replicas/network shares. Validation rejects obvious network paths, but a mapped network drive is an operator responsibility.
- `better-sqlite3` requires a compatible native binary. The locked version ships prebuilt binaries, including Windows x64. Project `.npmrc` disables dependency lifecycle scripts: npm 11 attempted an unnecessary implicit `node-gyp rebuild` despite this package's shipped binaries. Explicit `npm run build`/`npm test` commands still run. If no shipped binary supports your platform, install Python and Visual Studio C++ Build Tools (Windows), then deliberately run `npm rebuild better-sqlite3 --ignore-scripts=false` and re-run verification. Do not silently change Node versions.
- Recheck this install policy when updating dependencies: a new dependency may genuinely require a lifecycle build. Do not suppress that failure and claim readiness.

## Install

Run from the project root:

```powershell
npm ci
Copy-Item .env.example .env
# Edit .env privately; do not paste your token into chat or logs.
npm run typecheck
npm test
npm run build
npm start
```

Fill `DISCORD_TOKEN`, `GUILD_ID` and `TRAP_CHANNEL_ID`. `DATABASE_PATH` defaults to `./data/jobs.sqlite`; `LOG_LEVEL` defaults to `info` and accepts debug/info/warn/error/critical.

Set `STATUS_GIF_URL` in `.env` to a direct HTTP/HTTPS GIF URL for the trap-channel Embed:

```dotenv
STATUS_GIF_URL=https://example.com/status.gif
```

If unset or blank, the original GIF is used. Invalid URLs prevent startup. Restart the bot after changing this value; the existing panel is updated on readiness.

Run from this directory so `.env` and relative paths resolve correctly. `npm start` uses `node --env-file=.env dist/index.js`; it does not build automatically. `npm run dev` builds then starts. Keep `.env`, DB and logs private. The ignore file excludes environment files (except the example), DB sidecars, dependencies and build output.

## Windows deployment (manual setup only)

No scheduled task/service is installed by this project.

1. Find the full Node executable path: `Get-Command node`.
2. Use a dedicated account that can access the token, DB and logs. Restrict the directory ACL to that account and trusted administrators (Security tab in Explorer).
3. Create a restricted local `logs` directory. Configure **external log rotation**, disk monitoring and alert forwarding.
4. In Task Scheduler, create a task that runs whether the user is logged on or not. Trigger at startup. Choose “Do not start a new instance” if already running; restart on failure every one minute. Disable the default execution time limit for this long-running bot.
5. For a direct action, set Program to the absolute `node.exe` path, arguments `--env-file=.env dist/index.js`, and Start in to the absolute project root. For log capture, use the launcher below instead.

Example `run-banbot.ps1` for an operator to create locally (replace paths):

```powershell
$ErrorActionPreference = 'Stop'
Set-Location 'C:\path\to\banbot'
$node = 'C:\Program Files\nodejs\node.exe'
New-Item -ItemType Directory -Force '.\logs' | Out-Null
& $node --env-file=.env dist/index.js >> '.\logs\stdout.log' 2>> '.\logs\stderr.log'
exit $LASTEXITCODE
```

Task action for this launcher: absolute `powershell.exe` path, arguments `-NoProfile -File "C:\path\to\banbot\run-banbot.ps1"`, Start in = project root. Review/sign the script according to local execution policy; do not bypass policy blindly.

Sleep, shutdown and lost connectivity suspend monitoring. The trap-room Embed is a counter panel, not an alert channel or live connectivity guarantee. Logs remain the only failure-alert channel. With `LOG_LEVEL=critical`, error-level manual-review/unresolved alerts are filtered, so `info`/`warn`/`error` is preferred for operations.

## Persistence and backups

SQLite uses WAL, `synchronous=FULL`, foreign keys, and transactional acceptance/state changes. A database binds permanently to one guild/channel scope; a mismatched configuration fails before login.

Schema v1 is upgraded transactionally to v2 at startup, preserving jobs/dedup and seeding the counter from completed jobs with a ban start and no error. Back up before upgrading. The previous v1 binary cannot open a v2 database; do not downgrade against the upgraded DB. Each new successful completion increments the counter in the same transaction as its state change.

Do not delete the DB to clear errors. Dedup history grows without automatic pruning. Monitor disk usage. Disk-full/write failures stop new intake and bans. After an owned ban, storage failure attempts a fresh ownership check and emergency unban before shutdown.

For a file backup, stop the process first and copy DB/WAL/SHM together consistently. Alternatively use SQLite's online backup mechanism. Copying only a live `.sqlite` file is not a safe backup.

## Recovery

Normal flow: `queued → banning → unbanning → completed`.

- Active recovery is loaded before intake; unbanning takes priority over banning/new queued work.
- `banning` after an uncertain result: fetch fresh ban. Exact marker permits unban; absent, foreign or unreadable reason requires `manual_review`. Never blindly re-ban.
- `unbanning`: absent ban completes; exact marker permits another unban attempt; foreign/null marker requires review.
- Fetch/unban network/timeout/5xx failures persist retries: exponential backoff from one second, capped at 60 seconds, with up to 20% jitter. Unban retries have no fixed attempt limit.
- Discord SDK retries are disabled for uncertain requests; its 429 queuing remains enabled. Tests cover this with a fake transport.
- Permission/hierarchy failures before a ban fail the job; permission loss when a ban may exist requires manual review.
- An unresolved ban alerts after 60 seconds, then at most every five minutes. Alert timestamps survive restart. Entering manual review also logs an immediate error.
- `manual_review` keeps the user's lock and is never automatically executed. Only `completed`/`failed` release the lock.
- SIGINT/SIGTERM disables intake and drains active calls for up to 15 seconds. If draining times out, the process exits nonzero without closing the DB under an active worker. Emergency cleanup permits no new unban after its ten-second deadline; requests already in flight are not claimed to be cancelled.

## Manual review runbook

1. **Stop the bot.** Back up the DB and sidecars consistently.
2. With trusted SQLite tooling, inspect job ID, guild/user, reason, state, ownership and error read-only.
3. Check the current Discord ban with an authorized tool that exposes its reason.
4. If the exact job marker owns the ban, manually unban and verify absence. If already absent, **do not ban again**.
5. If foreign/unreadable, coordinate with the moderator and leave the ban untouched. Do not guess ownership.
6. Only after that decision, mark the job `completed` (confirmed owned unban/absent) or `failed` (foreign ban preserved/no further automation). Preserve `seen_messages`.

Operator-only SQL; bind the verified ID and chosen resolution after the checks above. The agent must not run this automatically:

```sql
BEGIN IMMEDIATE;
SELECT id, guildId, userId, state, reason, ownership, lastError
FROM jobs WHERE id = :verified_job_id;
UPDATE jobs SET state = :resolution,
  updatedAt = CAST(strftime('%s','now') AS INTEGER) * 1000,
  lastError = 'OPERATOR_RESOLVED'
WHERE id = :verified_job_id AND state = 'manual_review'
  AND :resolution IN ('completed','failed');
SELECT changes(); -- require 1; otherwise ROLLBACK and investigate
COMMIT;
```

## Reading logs

One JSON object per line: ISO timestamp, severity and event, plus whitelisted job/guild/channel/user identifiers, state, errorCode and retryAt when relevant. `retryAt` is Unix milliseconds. No raw HTTP errors, member content or attachments are serialized; configured secrets are redacted in events and string fields.

Useful events: `ready`, `disconnected`, `trigger_created`, `trigger_coalesced`, `trigger_duplicate`, `job_retry`, `job_completed`, `job_failed`, `job_manual_review`, `softban_unresolved`, `worker_storage_failure`, `application_fatal`, `shutdown_timeout`, `boot_failed`.

Codes include `OWNER`, `HIERARCHY`, `50013` (permissions), `PREEXISTING_BAN`, `BAN_OWNERSHIP_MISMATCH`, `AMBIGUOUS_BAN_ABSENT`, `ETIMEDOUT`, `HTTP_503`, `DATABASE_FAILURE`. Boot errors are deliberately sanitized; inspect local configuration without printing the token.

## Offline verification and staging

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

Tests use real temporary SQLite, fake Discord APIs/clocks and simulated transport. They never need a real token and never call Discord. They cover durability/reopen, dedup, filters, role/permission errors, ownership, ambiguous results, retry/alert throttling, crash boundaries, emergency cleanup, queue priority, reconnection and shutdown. Simulations do not prove power-loss guarantees on all hardware.

**Real Discord staging: NOT RUN. Deployment: NOT RUN.** Offline success does not establish production readiness.

With explicit permission and a disposable guild/member:

- [ ] Configure bot permissions/role; send a test member message outside the trap room (no removal).
- [ ] Send text/file/sticker in the trap room; verify removal and that the ban entry disappears.
- [ ] Verify recent messages across the guild are deleted eventually; do not claim deletion older than seven days.
- [ ] Rejoin with an invite and confirm a new message can trigger again.
- [ ] Test hierarchy failure with a disposable role; verify logged failure without unban.
- [ ] Test another bot only with a disposable bot, not production integrations.
- [ ] Check JSON job identities/results and external alert forwarding.
- [ ] Verify the trap-room GIF Embed and disabled `โดนไปแล้ว N ครั้ง` button. A completed softban increments once; failures/pending/manual-review jobs do not increment. Restart and confirm the same message and count survive. Delete the panel and confirm recreation within one minute.
- [ ] Check channel overrides for `SendMessages`, `EmbedLinks` and `ReadMessageHistory`; missing permissions prevent new intake, but owned-ban recovery still takes priority.

Design and implementation recipe: `docs/superpowers/specs/2026-09-13-discord-trap-softban-design.md` and `docs/superpowers/plans/2026-09-13-discord-trap-softban.md`.
