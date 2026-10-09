import { expect, it } from 'vitest';
import { readConfig } from '../src/config.js';

const valid = {
  DISCORD_TOKEN: 'test-secret',
  GUILD_ID: '111111111111111111',
  TRAP_CHANNEL_ID: '222222222222222222',
  DATABASE_PATH: './data/jobs.sqlite',
  LOG_LEVEL: 'info',
};

it.each(['https://example.com/custom.gif', 'http://example.com/custom.gif'])('reads a custom status GIF URL %s and trims whitespace', url => {
  expect(readConfig({ ...valid, STATUS_GIF_URL: `  ${url}  ` })).toMatchObject({ statusGifUrl: url });
});

it.each([undefined, '', '   '])('defaults the status GIF URL when unset or blank (%s)', value => {
  expect(readConfig({ ...valid, STATUS_GIF_URL: value })).toMatchObject({
    statusGifUrl: 'https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExdndubTU3NjhxenZpb3hjbDV3dTY0N3NpMmh6ZDJvZjV0Z2xvY2c3byZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/26ufgbn5OaTw6604o/giphy.gif',
  });
});

it.each(['not-a-url', '/local.gif', 'ftp://example.com/image.gif', 'file:///image.gif', 'https://'])('rejects invalid status GIF URL %s', value => {
  expect(() => readConfig({ ...valid, STATUS_GIF_URL: value })).toThrow('STATUS_GIF_URL');
});

it('reads explicit config', () => {
  expect(readConfig(valid)).toMatchObject({
    guildId: valid.GUILD_ID,
    trapChannelId: valid.TRAP_CHANNEL_ID,
    databasePath: './data/jobs.sqlite',
    logLevel: 'info',
  });
});

it.each(['', 'abc', '-1', '123'])('rejects invalid guild ID %s', value => {
  expect(() => readConfig({ ...valid, GUILD_ID: value })).toThrow('GUILD_ID');
});

it.each(['', 'abc', '0123456789012345678'])('rejects invalid trap channel ID %s', value => {
  expect(() => readConfig({ ...valid, TRAP_CHANNEL_ID: value })).toThrow('TRAP_CHANNEL_ID');
});

it('rejects missing token without exposing a token', () => {
  expect(() => readConfig({ ...valid, DISCORD_TOKEN: '' })).toThrow('DISCORD_TOKEN');
  expect(() => readConfig({ ...valid, DISCORD_TOKEN: '   ' })).toThrow('DISCORD_TOKEN');
  expect(() => readConfig({ ...valid, DISCORD_TOKEN: '' })).not.toThrow('test-secret');
});

it('rejects ephemeral storage and invalid log level', () => {
  expect(() => readConfig({ ...valid, DATABASE_PATH: ':memory:' })).toThrow('DATABASE_PATH');
  expect(() => readConfig({ ...valid, LOG_LEVEL: 'verbose' })).toThrow('LOG_LEVEL');
});

it('rejects network and file-URI database paths', () => {
  expect(() => readConfig({ ...valid, DATABASE_PATH: 'file::memory:' })).toThrow('DATABASE_PATH');
  expect(() => readConfig({ ...valid, DATABASE_PATH: '\\\\server\\share\\db.sqlite' })).toThrow('DATABASE_PATH');
  expect(() => readConfig({ ...valid, DATABASE_PATH: '//server/share/db.sqlite' })).toThrow('DATABASE_PATH');
  expect(() => readConfig({ ...valid, DATABASE_PATH: '   ' })).toThrow('DATABASE_PATH');
});

it('accepts the maximum unsigned snowflake and rejects larger values', () => {
  const max = '18446744073709551615';
  expect(readConfig({ ...valid, GUILD_ID: max })).toMatchObject({ guildId: max });
  expect(() => readConfig({ ...valid, GUILD_ID: '18446744073709551616' })).toThrow('GUILD_ID');
});

it('applies defaults for optional values', () => {
  expect(readConfig({ ...valid, DATABASE_PATH: '', LOG_LEVEL: '' })).toMatchObject({
    databasePath: './data/jobs.sqlite',
    logLevel: 'info',
  });
});
