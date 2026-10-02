import { ChannelType, type Client } from 'discord.js';
import { expect, it, vi } from 'vitest';
import { createStatusPublisher } from '../src/status-panel.js';

function fixture() {
  const edit = vi.fn().mockResolvedValue(undefined);
  const fetch = vi.fn().mockResolvedValue({ id: 'panel', author: { id: 'self' }, edit });
  const send = vi.fn().mockResolvedValue({ id: 'new-panel' });
  const channel = { guildId: 'g', type: ChannelType.GuildText, messages: { fetch }, send };
  const client = { user: { id: 'self' }, channels: { fetch: vi.fn().mockResolvedValue(channel) } };
  return { publish: createStatusPublisher(client as unknown as Client, 'g', 'c'), client, channel, fetch, edit, send };
}
it('sends the GIF panel with the completed count then edits its stored message', async () => {
  const f = fixture();
  expect(await f.publish(null, 0)).toBe('new-panel');
  expect(f.send.mock.calls[0][0].components[0].components[0]).toMatchObject({ label: 'โดนไปแล้ว 0 ครั้ง', disabled: true });
  expect(await f.publish('panel', 3)).toBe('panel');
  expect(f.fetch).toHaveBeenCalledWith({ message: 'panel', force: true });
  expect(f.edit.mock.calls[0][0].components[0].components[0].label).toBe('โดนไปแล้ว 3 ครั้ง');
  expect(f.send).toHaveBeenCalledOnce();
});
it('replaces a deleted panel but never replaces a foreign or unreadable message', async () => {
  const f = fixture();
  f.fetch.mockRejectedValueOnce({ code: 10008 });
  expect(await f.publish('panel', 2)).toBe('new-panel');
  f.send.mockClear();
  f.fetch.mockRejectedValueOnce({ code: 50013 });
  await expect(f.publish('panel', 2)).rejects.toMatchObject({ code: 50013 });
  f.fetch.mockResolvedValueOnce({ id: 'panel', author: { id: 'other' }, edit: f.edit });
  await expect(f.publish('panel', 2)).rejects.toThrow('ownership');
  expect(f.send).not.toHaveBeenCalled(); expect(f.edit).not.toHaveBeenCalled();
});
it('does not create a duplicate when editing times out, and rejects another guild', async () => {
  const f = fixture();
  f.edit.mockRejectedValueOnce({ code: 'ETIMEDOUT' });
  await expect(f.publish('panel', 1)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  expect(f.send).not.toHaveBeenCalled();
  f.channel.guildId = 'other';
  await expect(f.publish(null, 1)).rejects.toThrow('scope');
  expect(f.send).not.toHaveBeenCalled();
});
