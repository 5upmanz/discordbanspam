import type { LogLevel } from './contracts.js';

export interface Config {
  token: string;
  guildId: string;
  trapChannelId: string;
  databasePath: string;
  logLevel: LogLevel;
}

const SNOWFLAKE = /^[1-9]\d{16,19}$/;
const MAX_SNOWFLAKE = 18446744073709551615n;
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'critical'];
const DEFAULT_DATABASE_PATH = './data/jobs.sqlite';

function requireSnowflake(value: string | undefined, name: string): string {
  const v = (value ?? '').trim();
  if (!SNOWFLAKE.test(v) || BigInt(v) > MAX_SNOWFLAKE) {
    throw new Error(`${name} must be a Discord snowflake`);
  }
  return v;
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const token = (env.DISCORD_TOKEN ?? '').trim();
  if (!token) {
    throw new Error('DISCORD_TOKEN is required');
  }

  const guildId = requireSnowflake(env.GUILD_ID, 'GUILD_ID');
  const trapChannelId = requireSnowflake(env.TRAP_CHANNEL_ID, 'TRAP_CHANNEL_ID');

  const rawPath = env.DATABASE_PATH;
  const databasePath =
    rawPath === undefined || rawPath === '' ? DEFAULT_DATABASE_PATH : rawPath.trim();
  if (
    databasePath === '' ||
    databasePath === ':memory:' ||
    databasePath.startsWith('file:') ||
    databasePath.startsWith('\\\\') ||
    databasePath.startsWith('//')
  ) {
    throw new Error('DATABASE_PATH must be a persistent local disk path');
  }

  const logLevel = (env.LOG_LEVEL ?? '').trim() || 'info';
  if (!LOG_LEVELS.includes(logLevel as LogLevel)) {
    throw new Error('LOG_LEVEL must be one of: debug, info, warn, error, critical');
  }

  return { token, guildId, trapChannelId, databasePath, logLevel: logLevel as LogLevel };
}
