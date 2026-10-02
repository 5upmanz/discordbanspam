import { expect, it, vi } from 'vitest';

it('incomplete configuration fails safely before creating a Discord client', async () => {
  vi.stubEnv('DISCORD_TOKEN', ''); vi.stubEnv('GUILD_ID', ''); vi.stubEnv('TRAP_CHANNEL_ID', '');
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const create = vi.fn(() => { throw new Error('Client must not be created'); });
  vi.doMock('../src/client-port.js', () => ({ createDiscordClient: create, bindClient: vi.fn() }));
  try {
    await import('../src/index.js');
    expect(create).not.toHaveBeenCalled(); expect(exit).toHaveBeenCalledWith(1);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('boot_failed'));
  } finally { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.doUnmock('../src/client-port.js'); }
});
