import type { Message } from './types';

/** How many messages a history page holds; a shorter page means the start of the chat was reached. */
export const PAGE = 60;

/**
 * Paging back through a chat's history. `start` is the oldest message loaded when a short page showed the
 * start of the chat was reached. It belongs to that message, not to the chat: if a reconnect replaces what's
 * loaded with a newer page (dropping the start), paging back works again.
 */
export type OlderPaging = { busy: boolean; start: string | null };

export const newPaging = (): OlderPaging => ({ busy: false, start: null });

const isLocal = (m: Message) => m.status === 'pending' || m.status === 'queued' || m.status === 'failed';

/** The oldest message the server knows of, among those loaded (optimistic sends aren't on the server yet). */
export function oldestLoaded(messages: Message[] | undefined): string | null {
  return messages?.find((m) => !isLocal(m))?.id ?? null;
}

/** Whether the start of the chat is what's loaded now. */
export const atStart = (p: OlderPaging, messages: Message[] | undefined) => !!p.start && p.start === oldestLoaded(messages);

/** Whether to ask for an older page: not while one is loading, not for a chat shorter than a page, not at the start. */
export function canLoadOlder(p: OlderPaging, messages: Message[] | undefined): boolean {
  return !p.busy && (messages?.length ?? 0) >= PAGE && !atStart(p, messages);
}

/** After an older page: a short one that loaded means the start is here. A failed one can be tried again. */
export function afterOlderPage(p: OlderPaging, ok: boolean, added: number, messages: Message[] | undefined): void {
  p.busy = false;
  if (ok && added < PAGE) p.start = oldestLoaded(messages);
}
