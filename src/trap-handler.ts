import type { Clock, Jobs, Log } from './contracts.js';

export interface MessageEnvelope {
  id: string; guildId: string | null; channelId: string;
  authorId: string; webhookId: string | null; system: boolean;
}
export function createTrapHandler(deps: {
  guildId: string; channelId: string; selfId: string; jobs: Jobs;
  clock: Clock; log: Log; wake: () => void; onFatal: (error: unknown) => void;
}): { handle(message: MessageEnvelope): void; setEnabled(value: boolean): void } {
  let enabled = false;
  return {
    setEnabled(value) { enabled = value; },
    handle(message) {
      if (!enabled || message.guildId !== deps.guildId || message.channelId !== deps.channelId || message.authorId === deps.selfId || message.webhookId !== null || message.system) return;
      try {
        const accepted = deps.jobs.accept({ guildId: message.guildId, channelId: message.channelId, userId: message.authorId, messageId: message.id }, deps.clock.now());
        deps.log.emit('info', `trigger_${accepted.kind}`, { jobId: accepted.job.id, guildId: message.guildId, channelId: message.channelId, userId: message.authorId });
        deps.wake();
      } catch (error) {
        enabled = false;
        deps.log.emit('critical', 'intake_storage_failure', { errorCode: 'DATABASE_FAILURE' });
        deps.onFatal(error);
      }
    },
  };
}
