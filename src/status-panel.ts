import type Database from 'better-sqlite3';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, type Client } from 'discord.js';
import type { Jobs, Log } from './contracts.js';
import { normalizeApiError } from './discord-adapter.js';

const gifUrl = 'https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExdndubTU3NjhxenZpb3hjbDV3dTY0N3NpMmh6ZDJvZjV0Z2xvY2c3byZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/26ufgbn5OaTw6604o/giphy.gif';
export function statusPayload(count: number) {
  return {
    embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('ห้องกับดัก • Softban')
      .setDescription('ส่งข้อความในห้องนี้จะถูกllบu').setImage(gifUrl).toJSON()],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder()
      .setCustomId('softban_count').setLabel(`โดนไปแล้ว ${count} ครั้ง`).setStyle(ButtonStyle.Secondary).setDisabled(true)).toJSON()],
    allowedMentions: { parse: [] },
  };
}
export interface StatusStore {
  read(): { count: number; messageId: string | null };
  saveMessageId(id: string): void;
}
export interface StatusPanel { start(): void; stop(timeoutMs?: number): Promise<boolean> }
export function createStatusStore(db: Database.Database, jobs: Jobs): StatusStore {
  return {
    read: () => ({ count: jobs.successfulCount(), messageId: (db.prepare('SELECT messageId FROM status_panel WHERE singleton = 1').get() as { messageId: string | null }).messageId }),
    saveMessageId: id => { db.prepare('UPDATE status_panel SET messageId = ? WHERE singleton = 1').run(id); },
  };
}
export function createStatusPublisher(client: Client, guildId: string, channelId: string) {
  return async (messageId: string | null, count: number): Promise<string> => {
    const channel = await client.channels.fetch(channelId, { force: true });
    if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== guildId) throw new Error('Status channel scope mismatch');
    const payload = statusPayload(count);
    if (messageId) {
      try {
        const message = await channel.messages.fetch({ message: messageId, force: true });
        if (message.author.id !== client.user?.id) throw new Error('Status message ownership mismatch');
        await message.edit(payload);
        return message.id;
      } catch (error) {
        // Only a definitively deleted message permits a replacement.
        if (normalizeApiError(error).code !== '10008') throw error;
      }
    }
    return (await channel.send(payload)).id;
  };
}
export function createStatusPanel(deps: {
  store: StatusStore; publish: (messageId: string | null, count: number) => Promise<string>; log: Log;
}): StatusPanel {
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  let lastCount: number | undefined;
  let ticks = 0;
  function refresh(force = false): void {
    if (pending) return;
    pending = (async () => {
      try {
        const { count, messageId } = deps.store.read();
        if (!force && count === lastCount) return;
        const id = await deps.publish(messageId, count);
        deps.store.saveMessageId(id);
        lastCount = count;
      } catch {
        // Panel failures must not stop owned-ban recovery or leak raw API errors.
        deps.log.emit('warn', 'status_panel_failed', { errorCode: 'STATUS_PANEL_FAILURE' });
      }
    })().finally(() => { pending = undefined; });
  }
  return {
    start() {
      lastCount = undefined;
      refresh(true);
      // Serialize requests; check for deleted panels once per minute even without new jobs.
      timer ??= setInterval(() => refresh(++ticks % 12 === 0), 5000);
    },
    async stop(timeoutMs = 15000) {
      clearInterval(timer); timer = undefined;
      if (!pending) return true;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          pending.then(() => true),
          new Promise<boolean>(resolve => { deadline = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
      } finally { clearTimeout(deadline); }
    },
  };
}
