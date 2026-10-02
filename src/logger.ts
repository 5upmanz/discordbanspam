import type { LogLevel, LogFields, Log } from './contracts.js';

export type { LogLevel, LogFields, Log };

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  critical: 50,
};

const FIELD_KEYS = [
  'jobId',
  'guildId',
  'channelId',
  'userId',
  'state',
  'errorCode',
  'retryAt',
] as const;

function redact(value: string, secrets: string[]): string {
  let out = value;
  for (const secret of secrets) {
    if (secret.length > 0) {
      out = out.split(secret).join('***');
    }
  }
  return out;
}

export function createLogger(
  level: LogLevel,
  secrets: string[],
  sink: (line: string) => void = line => process.stdout.write(line + '\n'),
): Log {
  const threshold = RANK[level];
  return {
    emit(level: LogLevel, event: string, fields?: LogFields): void {
      if (RANK[level] < threshold) return;
      const record: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        level,
        event: redact(event, secrets),
      };
      if (fields) {
        for (const key of FIELD_KEYS) {
          const value = fields[key];
          if (value === undefined) continue;
          record[key] = typeof value === 'string' ? redact(value, secrets) : value;
        }
      }
      sink(JSON.stringify(record));
    },
  };
}
