import { expect, it, vi } from 'vitest';
import { Events, GatewayIntentBits, type ClientEvents } from 'discord.js';
import { createDiscordClient, bindClient } from '../src/client-port.js';

it('uses only non-privileged intents and projects other-bot messages without content', async () => {
  const client = createDiscordClient(), port = bindClient(client), receive = vi.fn();
  try {
    expect(client.options.intents.bitfield).toBe(GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages);
    expect(client.rest.options.retries).toBe(0); expect(client.rest.options.timeout).toBe(10000);
    port.onMessage(receive);
    const payload = { id: 'm', guildId: 'g', channelId: 'c', author: { id: 'other-bot', bot: true }, webhookId: null, system: false, content: 'must not log' };
    // Exercise the real event binding while preserving the Discord boundary type.
    client.emit(Events.MessageCreate, payload as unknown as ClientEvents[Events.MessageCreate][0]);
    expect(receive).toHaveBeenCalledWith({ id: 'm', guildId: 'g', channelId: 'c', authorId: 'other-bot', webhookId: null, system: false });
    expect(() => port.selfId()).toThrow('ready');
  } finally { await client.destroy(); }
});
it.each(['503', 'ECONNRESET', 'AbortError'])('SDK does not repeat an uncertain ban request: %s', async failure => {
  const client = createDiscordClient();
  const send = vi.fn(async () => {
    if (failure === '503') return new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } });
    throw Object.assign(new Error(failure), failure === 'AbortError' ? { name: failure } : { code: failure });
  });
  client.rest.options.makeRequest = send as unknown as typeof client.rest.options.makeRequest; client.rest.setToken('fake-token');
  try {
    await expect(client.rest.put('/guilds/111111111111111111/bans/222222222222222222', { body: { delete_message_seconds: 604800 } })).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  } finally { await client.destroy(); }
});
it('SDK still queues rate limits', async () => {
  const client = createDiscordClient(); client.rest.setToken('fake-token'); client.rest.options.offset = 0;
  const send = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '0', 'Content-Type': 'application/json' } })).mockResolvedValueOnce(new Response(null, { status: 204 }));
  client.rest.options.makeRequest = send;
  try { await client.rest.put('/guilds/111111111111111111/bans/222222222222222222'); expect(send).toHaveBeenCalledTimes(2); }
  finally { await client.destroy(); }
});
