import type { DraftFile, InboxItem } from './types';

export type ChatFilter = 'all' | 'running' | 'needs-you';
export type ChatActivity = { typing?: Record<string, number>; inbox?: Record<string, InboxItem>; me?: { role: 'owner' | 'member' } };

/** A request takes precedence over work: waiting for an answer is not a running task. */
export function chatActivity(activity: ChatActivity | undefined, chatId: string, now = Date.now()) {
  const waiting = Object.values(activity?.inbox ?? {}).filter((item) =>
    item.chat_id === chatId && item.status === 'pending' && item.kind !== 'result');
  const pending = waiting.filter((item) => item.kind !== 'approval' || activity?.me?.role !== 'member').length;
  return { pending, running: !waiting.length && (activity?.typing?.[chatId] ?? 0) > now };
}

export function matchesChatFilter(filter: ChatFilter, state: ReturnType<typeof chatActivity>): boolean {
  return filter === 'all' || (filter === 'running' ? state.running : state.pending > 0);
}

/** A draft always wins over the last received preview; attachments and reply-only drafts count too. */
export function draftPreview(text: string | undefined, files: DraftFile[] = [], replying = false): string | null {
  if (text?.trim()) return `Draft · ${text.trim().replace(/\s+/g, ' ')}`;
  if (files.length) return `Draft · ${files.length === 1 ? files[0].name : `${files.length} attachments`}`;
  return replying ? 'Draft · Reply' : null;
}

export function chatActivityLabel(state: ReturnType<typeof chatActivity>): string | null {
  return state.pending ? `Needs you${state.pending > 1 ? ` · ${state.pending}` : ''}` : state.running ? 'Running' : null;
}
