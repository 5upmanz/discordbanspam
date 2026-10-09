import type { LogLevel } from './contracts.js';

export interface Config {
  token: string;
  guildId: string;
  trapChannelId: string;
  statusGifUrl: string;
  databasePath: string;
  logLevel: LogLevel;
}

const SNOWFLAKE = /^[1-9]\d{16,19}$/;
const MAX_SNOWFLAKE = 18446744073709551615n;
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'critical'];
const DEFAULT_DATABASE_PATH = './data/jobs.sqlite';
const DEFAULT_STATUS_GIF_URL = 'https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExdndubTU3NjhxenZpb3hjbDV3dTY0N3NpMmh6ZDJvZjV0Z2xvY2c3byZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/26ufgbn5OaTw6604o/giphy.gif';

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

  const statusGifUrl = (env.STATUS_GIF_URL ?? '').trim() || DEFAULT_STATUS_GIF_URL;
  try {
    const url = new URL(statusGifUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
  } catch {
    throw new Error('STATUS_GIF_URL must be a valid HTTP or HTTPS URL');
  }

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

  return { token, guildId, trapChannelId, statusGifUrl, databasePath, logLevel: logLevel as LogLevel };
}
