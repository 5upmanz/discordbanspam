import { expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';

it('redacts secrets and emits parseable JSON', () => {
  const lines: string[] = [];
  const log = createLogger('info', ['test-secret'], line => lines.push(line));
  log.emit('error', 'api_failed', { errorCode: 'test-secret' });
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain('test-secret');
  const parsed = JSON.parse(lines[0]);
  expect(parsed).toMatchObject({ level: 'error', event: 'api_failed' });
  expect(parsed.errorCode).toBe('***');
  expect(typeof parsed.timestamp).toBe('string');
});

it('redacts secrets in event names', () => {
  const lines: string[] = [];
  createLogger('info', ['test-secret'], line => lines.push(line)).emit('error', 'failed:test-secret');
  expect(JSON.parse(lines[0]).event).toBe('failed:***');
});

it('filters below configured level', () => {
  const lines: string[] = [];
  createLogger('warn', [], line => lines.push(line)).emit('info', 'ready');
  expect(lines).toEqual([]);
});

it('keeps whitelisted fields only and drops unknown fields', () => {
  const lines: string[] = [];
  createLogger('debug', [], line => lines.push(line)).emit('debug', 'job', {
    jobId: 'j1',
    guildId: 'g1',
    channelId: 'c1',
    userId: 'u1',
    state: 'banning',
    errorCode: 'ETIMEDOUT',
    retryAt: 1234,
  });
  expect(JSON.parse(lines[0])).toMatchObject({
    level: 'debug',
    event: 'job',
    jobId: 'j1',
    guildId: 'g1',
    channelId: 'c1',
    userId: 'u1',
    state: 'banning',
    errorCode: 'ETIMEDOUT',
    retryAt: 1234,
  });
});

it('redacts secrets inside longer strings', () => {
  const lines: string[] = [];
  createLogger('info', ['abc123'], line => lines.push(line)).emit('info', 'x', {
    errorCode: 'prefix-abc123-suffix',
  });
  expect(lines[0]).not.toContain('abc123');
});
