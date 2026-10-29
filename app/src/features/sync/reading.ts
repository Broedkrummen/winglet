import type { Message } from '../../lib/types';
import type { Json, Value } from './model';

export type ResumeAnchor = { message_id: string; position?: number };
export type ReadingEntry = { serverId: string; fingerprint: string; chatId: string; watermark: number; resume?: ResumeAnchor };
export const readingKey = (serverId: string, fingerprint: string, chatId: string) => JSON.stringify([serverId, fingerprint, chatId]);
export const validPosition = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function parseReadingEntry(value: unknown): ReadingEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const entry = value as ReadingEntry;
  if (![entry.serverId, entry.fingerprint, entry.chatId].every(item => typeof item === 'string' && item.length <= 160)
    || !entry.serverId || !entry.chatId || !validPosition(entry.watermark)) return;
  const resume = resumeAnchor(entry.resume);
  if (entry.resume !== undefined && !resume) return;
  return { serverId: entry.serverId, fingerprint: entry.fingerprint, chatId: entry.chatId, watermark: entry.watermark,
    ...(resume ? { resume } : {}) };
}

export function resumeAnchor(value: unknown): ResumeAnchor | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const anchor = value as ResumeAnchor;
  if (typeof anchor.message_id !== 'string' || !anchor.message_id || anchor.message_id.length > 160
    || Object.keys(anchor).some(key => !['message_id', 'position'].includes(key))
    || (anchor.position !== undefined && (!validPosition(anchor.position) || anchor.position === 0))) return;
  return { message_id: anchor.message_id, ...(anchor.position === undefined ? {} : { position: anchor.position }) };
}

export function readingValues(entry: ReadingEntry): Record<string, Value> {
  return { server_id: { deleted: false, value: entry.serverId }, server_fingerprint: { deleted: false, value: entry.fingerprint },
    chat_id: { deleted: false, value: entry.chatId }, watermark: { deleted: false, value: entry.watermark },
    resume: entry.resume ? { deleted: false, value: entry.resume as unknown as Json } : { deleted: true } };
}

/** Only actual, final transcript rows with native positions can advance read progress. */
export function visibleReading(messages: readonly Message[]): { watermark: number; anchor?: ResumeAnchor } {
  const confirmed = messages.filter(message => message.status === 'final' && validPosition(message.position) && message.position! > 0
    && message.id !== message.meta?.client_id);
  const watermark = Math.max(0, ...confirmed.map(message => message.position!));
  const oldest = confirmed.reduce<Message | undefined>((prior, message) => !prior || message.position! < prior.position! ? message : prior, undefined);
  return { watermark, ...(oldest ? { anchor: { message_id: oldest.id, position: oldest.position } } : {}) };
}
