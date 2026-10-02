export type State =
  | 'queued'
  | 'banning'
  | 'unbanning'
  | 'completed'
  | 'failed'
  | 'manual_review';

export type Ownership = 'unchecked' | 'matched' | 'absent' | 'foreign' | 'unknown';

export interface Trigger {
  guildId: string;
  channelId: string;
  userId: string;
  messageId: string;
}

export interface Job extends Trigger {
  id: string;
  reason: string;
  state: State;
  ownership: Ownership;
  createdAt: number;
  updatedAt: number;
  banStartedAt: number | null;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  lastAlertAt: number | null;
}

export type JobPatch = Partial<
  Pick<
    Job,
    | 'state'
    | 'ownership'
    | 'banStartedAt'
    | 'attempts'
    | 'nextAttemptAt'
    | 'lastError'
    | 'lastAlertAt'
  >
>;

export interface Jobs {
  accept(trigger: Trigger, now: number): {
    kind: 'created' | 'coalesced' | 'duplicate';
    job: Job;
  };
  get(id: string): Job;
  change(id: string, expected: State, patch: JobPatch, now: number): Job;
  nextDue(now: number): Job | null;
  recoverable(): Job[];
  overdue(now: number): Job[];
}

export type FailureKind = 'transient' | 'permanent';

export class ApiFailure extends Error {
  constructor(
    public readonly kind: FailureKind,
    public readonly code: string,
  ) {
    super(code);
    this.name = 'ApiFailure';
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
  jobId: string;
  guildId: string;
  channelId: string;
  userId: string;
  state: State;
  errorCode: string;
  retryAt: number;
}>;

export interface Log {
  emit(level: LogLevel, event: string, fields?: LogFields): void;
}

export interface Clock {
  now(): number;
  random(): number;
}

export interface Worker {
  run(job: Job): Promise<void>;
  checkAlerts(): void;
}

export interface Scheduler {
  start(): void;
  wake(): void;
  stop(timeoutMs: number): Promise<boolean>; // true only if drained
}
