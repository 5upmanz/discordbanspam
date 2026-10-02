import { expect, it, vi } from 'vitest';
import { ChannelType, PermissionFlagsBits, type Client } from 'discord.js';
import { createDiscordAdapter, normalizeApiError } from '../src/discord-adapter.js';

function fixture() {
  const create = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue(undefined);
  const fetchBan = vi.fn().mockResolvedValue({ reason: null });
  const self = { permissions: { has: vi.fn().mockReturnValue(true) }, roles: { highest: { comparePositionTo: vi.fn().mockReturnValue(1) } } };
  const target = { bannable: true, roles: { highest: {} } };
  const fetchMember = vi.fn().mockImplementation(async ({ user }) => user === 'self' ? self : target);
  const channel = { guildId: 'g', type: ChannelType.GuildText, permissionsFor: vi.fn().mockReturnValue({ has: vi.fn().mockReturnValue(true) }) };
  const guild = { id: 'g', ownerId: 'owner', bans: { create, remove, fetch: fetchBan }, members: { fetch: fetchMember } };
  const client = { user: { id: 'self' }, guilds: { fetch: vi.fn().mockResolvedValue(guild) }, channels: { fetch: vi.fn().mockResolvedValue(channel) } };
  return { api: createDiscordAdapter(client as unknown as Client), create, remove, fetchBan, fetchMember, self, target, channel };
}
it('uses the seven-day window and marker, and performs fresh lookups', async () => {
  const f = fixture();
  await f.api.ban('g', 'u', 'trap-softban:j');
  expect(f.create).toHaveBeenCalledWith('u', { deleteMessageSeconds: 604800, reason: 'trap-softban:j' });
  expect(await f.api.getBan('g', 'u')).toEqual({ reason: null });
  expect(f.fetchBan).toHaveBeenCalledWith({ user: 'u', force: true });
  await f.api.canBan('g', 'u');
  expect(f.fetchMember).toHaveBeenCalledWith({ user: 'u', force: true });
  await f.api.unban('g', 'u', 'trap-softban:j');
  expect(f.remove).toHaveBeenCalledWith('u', 'trap-softban:j');
});
it('accepts only Unknown Ban as absence/success', async () => {
  const f = fixture();
  f.fetchBan.mockRejectedValue({ code: 10026, status: 404 });
  expect(await f.api.getBan('g', 'u')).toBeNull();
  f.remove.mockRejectedValue({ code: 10026, status: 404 });
  await expect(f.api.unban('g', 'u', 'j')).resolves.toBeUndefined();
  f.fetchBan.mockRejectedValue({ code: 50013, status: 403 });
  f.remove.mockRejectedValue({ code: 50013, status: 403 });
  await expect(f.api.getBan('g', 'u')).rejects.toMatchObject({ kind: 'permanent', code: '50013' });
  await expect(f.api.unban('g', 'u', 'j')).rejects.toMatchObject({ code: '50013' });
});
it('checks scope, channel type, permissions, owner and hierarchy', async () => {
  const f = fixture();
  await f.api.preflight('g', 'c');
  expect(f.self.permissions.has).toHaveBeenCalledWith(PermissionFlagsBits.BanMembers);
  f.channel.guildId = 'other';
  await expect(f.api.preflight('g', 'c')).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' });
  f.channel.guildId = 'g'; f.channel.type = ChannelType.GuildVoice;
  await expect(f.api.preflight('g', 'c')).rejects.toMatchObject({ code: 'CHANNEL_TYPE' });
  await expect(f.api.canBan('g', 'owner')).rejects.toMatchObject({ code: 'OWNER' });
  for (const position of [0, -1]) {
    f.self.roles.highest.comparePositionTo.mockReturnValue(position);
    await expect(f.api.canBan('g', 'u')).rejects.toMatchObject({ code: 'HIERARCHY' });
  }
  f.self.permissions.has.mockReturnValue(false);
  await expect(f.api.canBan('g', 'u')).rejects.toMatchObject({ code: '50013' });
});
it('requires ViewChannel and propagates Unknown Member without banning', async () => {
  const f = fixture();
  f.channel.permissionsFor.mockReturnValue({ has: vi.fn().mockReturnValue(false) });
  await expect(f.api.preflight('g', 'c')).rejects.toMatchObject({ code: '50013' });
  f.fetchMember.mockRejectedValue({ status: 404, code: 10007 });
  await expect(f.api.canBan('g', 'u')).rejects.toMatchObject({ code: '10007' });
  expect(f.create).not.toHaveBeenCalled();
});

it.each(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'UND_ERR_SOCKET'])('classifies network %s as transient', code => {
  expect(normalizeApiError({ code })).toMatchObject({ kind: 'transient', code });
});
it('normalizes HTTP errors without serializing messages', () => {
  expect(normalizeApiError({ status: 503 })).toMatchObject({ kind: 'transient', code: 'HTTP_503' });
  expect(normalizeApiError({ status: 429 })).toMatchObject({ kind: 'transient', code: 'RATE_LIMIT' });
  expect(normalizeApiError({ status: 403, code: 50013 })).toMatchObject({ kind: 'permanent', code: '50013' });
  expect(normalizeApiError(new Error('secret'))).toMatchObject({ code: 'UNCLASSIFIED_API_ERROR' });
});
