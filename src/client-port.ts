import { Client, Events, GatewayIntentBits } from 'discord.js';
import type { ClientPort } from './app.js';

export function createDiscordClient(): Client {
  return new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages], rest: { retries: 0, timeout: 10000 } });
}
export function bindClient(client: Client): ClientPort {
  return {
    selfId() { if (!client.isReady()) throw new Error('Client is not ready'); return client.user.id; },
    async login(token) { await client.login(token); },
    async destroy() { await client.destroy(); },
    onReady(fn) { client.on(Events.ClientReady, fn); },
    onMessage(fn) {
      client.on(Events.MessageCreate, message => fn({ id: message.id, guildId: message.guildId, channelId: message.channelId, authorId: message.author.id, webhookId: message.webhookId, system: message.system }));
    },
    onConnection(fn) {
      client.on(Events.ShardDisconnect, () => fn(false));
      client.on(Events.ShardReconnecting, () => fn(false));
      client.on(Events.ShardResume, () => fn(true));
    },
    onError(fn) { client.on(Events.Error, fn); client.on(Events.ShardError, fn); },
  };
}
