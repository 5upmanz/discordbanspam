import { expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createJobs } from '../src/jobs.js';
import { createTrapHandler } from '../src/trap-handler.js';

it('gates intake and filters scope/self/webhook/system but accepts any member envelope', () => {
  const scope = { guildId: 'g', channelId: 'c' };
  const db = openDatabase(':memory:', scope);
  try {
    const jobs = createJobs(db), wake = vi.fn(), fatal = vi.fn();
    const handler = createTrapHandler({ ...scope, selfId: 'self', jobs, clock: { now: () => 10, random: () => 0 }, log: { emit: vi.fn() }, wake, onFatal: fatal });
    const message = { id: 'm', ...scope, authorId: 'u', webhookId: null, system: false };
    handler.handle(message);
    expect(jobs.recoverable()).toEqual([]);
    handler.setEnabled(true);
    for (const patch of [{ guildId: null }, { guildId: 'other' }, { channelId: 'thread' }, { authorId: 'self' }, { webhookId: 'w' }, { system: true }]) handler.handle({ ...message, ...patch });
    expect(jobs.recoverable()).toEqual([]);
    handler.handle(message); handler.handle(message); handler.handle({ ...message, id: 'm2' });
    expect(jobs.recoverable()).toHaveLength(1);
    expect(wake).toHaveBeenCalledTimes(3);
    handler.setEnabled(false);
    handler.handle({ ...message, id: 'm3', authorId: 'u2' });
    expect(jobs.recoverable()).toHaveLength(1);
    handler.setEnabled(true);
    vi.spyOn(jobs, 'accept').mockImplementation(() => { throw new Error('disk full'); });
    handler.handle({ ...message, id: 'm4' }); handler.handle({ ...message, id: 'm5' });
    expect(fatal).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledTimes(3);
  } finally { db.close(); }
});
