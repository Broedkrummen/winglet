import type { Message } from './types';

/** Presentation only: never hide a rich reply or classify a prefix that is still streaming. */
export function statusNoticeText(message: Message): string | null {
  const meta = message.meta ?? {};
  if (message.role !== 'bot' || message.status !== 'final'
    || meta.attachments?.length || meta.reply_to || meta.picker || meta.inbox_id || meta.routine || meta.kind) return null;
  const text = message.text.trim();
  if (text.length >= 200 || /[\r\n]/u.test(text)) return null;
  const match = /^(?:⏳|⚡|⏱|\u{1F504}|⚠)️?\s+(.+)$/u.exec(text);
  if (!match) return null;
  const body = match[1].trim();
  if (!body || /```|~~~|`|\[[^\]]*\]\(|\*\*|__|<https?:/.test(body) || /^(?:#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|[-*_]{3,}$)/.test(body)) return null;
  return body;
}
