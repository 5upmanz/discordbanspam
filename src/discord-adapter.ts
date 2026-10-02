import { ChannelType, PermissionFlagsBits, type Client } from 'discord.js';
import { ApiFailure, type DiscordPort } from './contracts.js';

function properties(error: unknown): { code?: unknown; status?: unknown; name?: unknown } {
  return typeof error === 'object' && error !== null ? error : {};
}
export function normalizeApiError(error: unknown): ApiFailure {
  if (error instanceof ApiFailure) return error;
  const { code, status, name } = properties(error);
  const network = ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'];
  if (typeof code === 'string' && network.includes(code)) return new ApiFailure('transient', code);
  if (name === 'AbortError' || name === 'TimeoutError') return new ApiFailure('transient', 'ETIMEDOUT');
  if (status === 429) return new ApiFailure('transient', 'RATE_LIMIT');
  if (typeof status === 'number' && status >= 500 && status < 600) return new ApiFailure('transient', `HTTP_${status}`);
  if (typeof code === 'number') return new ApiFailure('permanent', String(code));
  if (typeof status === 'number' && status >= 400 && status < 500) return new ApiFailure('permanent', `HTTP_${status}`);
  return new ApiFailure('permanent', 'UNCLASSIFIED_API_ERROR');
}
export function createDiscordAdapter(client: Client): DiscordPort {
  async function invoke<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) { throw normalizeApiError(error); }
  }
  return {
    preflight: (guildId, channelId) => invoke(async () => {
      const guild = await client.guilds.fetch(guildId);
      const channel = await client.channels.fetch(channelId, { force: true });
      if (guild.id !== guildId || !channel || !('guildId' in channel) || channel.guildId !== guildId) throw new ApiFailure('permanent', 'SCOPE_MISMATCH');
      if (channel.type !== ChannelType.GuildText) throw new ApiFailure('permanent', 'CHANNEL_TYPE');
      if (!client.user) throw new ApiFailure('permanent', 'NOT_READY');
      const self = await guild.members.fetch({ user: client.user.id, force: true });
      if (!self.permissions.has(PermissionFlagsBits.BanMembers) || !channel.permissionsFor(self)?.has(PermissionFlagsBits.ViewChannel)) throw new ApiFailure('permanent', '50013');
    }),
    canBan: (guildId, userId) => invoke(async () => {
      const guild = await client.guilds.fetch(guildId);
      if (userId === guild.ownerId) throw new ApiFailure('permanent', 'OWNER');
      if (!client.user) throw new ApiFailure('permanent', 'NOT_READY');
      const self = await guild.members.fetch({ user: client.user.id, force: true });
      if (!self.permissions.has(PermissionFlagsBits.BanMembers)) throw new ApiFailure('permanent', '50013');
      const target = await guild.members.fetch({ user: userId, force: true });
      if (self.roles.highest.comparePositionTo(target.roles.highest) <= 0 || !target.bannable) throw new ApiFailure('permanent', 'HIERARCHY');
    }),
    getBan: async (guildId, userId) => {
      try {
        const guild = await client.guilds.fetch(guildId);
        const ban = await guild.bans.fetch({ user: userId, force: true });
        return { reason: ban.reason ?? null };
      } catch (error) {
        if (properties(error).code === 10026) return null;
        throw normalizeApiError(error);
      }
    },
    ban: (guildId, userId, reason) => invoke(async () => {
      const guild = await client.guilds.fetch(guildId);
      await guild.bans.create(userId, { deleteMessageSeconds: 604800, reason });
    }),
    unban: async (guildId, userId, reason) => {
      try {
        const guild = await client.guilds.fetch(guildId);
        await guild.bans.remove(userId, reason);
      } catch (error) {
        if (properties(error).code !== 10026) throw normalizeApiError(error);
      }
    },
  };
}
