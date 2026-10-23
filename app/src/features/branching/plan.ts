import type { BranchMessageCapability, BranchState, Chat, ChatBranch, Message } from '../../lib/types';

export type BranchMode = 'edit' | 'branch' | 'regenerate';
export type BranchWhere = 'new' | 'in_place';

/**
 * The substantive conversation in insertion order. Mirrors the server's boundary rule so the
 * sheet's "copies N, leaves M behind" sentence matches what the server will do. The server still
 * verifies every boundary against the real Hermes transcript.
 */
export function settledMessages(messages: readonly Message[]): Message[] {
  return messages.filter((m) => {
    const meta = m.meta ?? {};
    if (m.role !== 'user' && m.role !== 'bot') return false;
    if (m.status !== 'final') return false;
    if (meta.hidden || meta.picker || meta.status_key || meta.inbox_id || meta.routine || meta.activity) return false;
    if (!m.text.trim() && !meta.attachments?.length) return false;
    if (m.role === 'bot' && !meta.attachments?.length && looksLikeToolProgress(m.text)) return false;
    return true;
  });
}

const PLAIN_TOOLS = new Set(['terminal', 'process', 'browser', 'todo', 'memory', 'patch', 'delegate', 'clarify', 'cronjob', 'vision', 'search', 'think']);

/** A small client-side copy of the server's tool-progress detector; only used for preview counts. */
function looksLikeToolProgress(text: string): boolean {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length || text.length > 1200) return false;
  const line = /^\p{Extended_Pictographic}\uFE0F?\s+([a-z][a-z0-9]*(?:[_.-][a-z0-9]+)*)(?:\s*:.*|\s*\.{3}|\s*…)?(?:\s+\(×\d+\))?$/u;
  const friendly = /^\p{Extended_Pictographic}\uFE0F?\s+(?:Searching|Reading|Running|Browsing|Clicking|Typing|Writing|Editing|Delegating|Scheduling|Asking|Generating|Looking|Listing|Updating)(?:\s.*)?$/u;
  return lines.every((l) => {
    const match = line.exec(l);
    return (!!match && (match[1].includes('_') || PLAIN_TOOLS.has(match[1]))) || friendly.test(l);
  });
}

export function messageIndex(messages: readonly Message[], id: string): number {
  return settledMessages(messages).findIndex((m) => m.id === id);
}

/** How many settled messages remain in the original chat if this action runs. */
export function laterCount(messages: readonly Message[], id: string, mode: BranchMode): number {
  const rows = settledMessages(messages);
  const index = rows.findIndex((m) => m.id === id);
  if (index < 0) return 0;
  if (mode === 'edit') return rows.length - index;
  const promptIndex = rows[index].role === 'bot'
    ? lastUserBefore(rows, index)
    : index;
  if (mode === 'regenerate') return rows.length - promptIndex;
  const nextUser = nextUserAfter(rows, index);
  return rows.length - nextUser;
}

/** How many settled messages the new branch will contain. */
export function copiesCount(messages: readonly Message[], id: string, mode: BranchMode): number {
  const rows = settledMessages(messages);
  const index = rows.findIndex((m) => m.id === id);
  if (index < 0) return 0;
  if (mode === 'edit') return index;
  const promptIndex = rows[index].role === 'bot'
    ? lastUserBefore(rows, index)
    : index;
  if (mode === 'regenerate') return promptIndex;
  return nextUserAfter(rows, index);
}

function lastUserBefore(rows: readonly Message[], index: number): number {
  for (let i = index - 1; i >= 0; i--) if (rows[i].role === 'user') return i;
  return index;
}

function nextUserAfter(rows: readonly Message[], index: number): number {
  for (let i = index + 1; i < rows.length; i++) if (rows[i].role === 'user') return i;
  return rows.length;
}

export function capability(state: BranchState | null | undefined, id: string): BranchMessageCapability | undefined {
  return state?.messages?.[id];
}

export function canEdit(state: BranchState | null | undefined, id: string): boolean {
  return !!state?.supported && !!capability(state, id)?.can_edit;
}

export function canBranch(state: BranchState | null | undefined, id: string): boolean {
  return !!state?.supported && !!capability(state, id)?.can_branch;
}

export function canRegenerate(state: BranchState | null | undefined, id: string): boolean {
  return !!state?.supported && !!capability(state, id)?.can_regenerate;
}

/** The newest settled bot message; in-place regeneration is only safe there. */
export function isLatestReply(messages: readonly Message[], id: string): boolean {
  const rows = settledMessages(messages);
  const last = rows[rows.length - 1];
  return !!last && last.id === id && last.role === 'bot';
}

export function canReplaceInPlace(state: BranchState | null | undefined, messages: readonly Message[], message: Message): boolean {
  const meta = message.meta ?? {};
  return canRegenerate(state, message.id) && isLatestReply(messages, message.id)
    && !meta.attachments?.length && !state?.busy;
}

export function actionLabel(mode: BranchMode, role: Message['role']): string {
  if (mode === 'edit') return 'Edit in a new branch';
  if (mode === 'regenerate') return 'Regenerate reply';
  return role === 'user' ? 'Branch from here' : 'Branch from this reply';
}

export function actionHint(mode: BranchMode, later: number, where: BranchWhere = 'new'): string {
  if (mode === 'branch') {
    return later ? `Copies this turn; ${later} later ${later === 1 ? 'message stays' : 'messages stay'} in the original chat.` : 'Copies this turn into a new chat.';
  }
  if (mode === 'edit') {
    if (later <= 1) return 'Your original message stays in the original chat.';
    return `Your original message and ${later - 1} later ${later - 1 === 1 ? 'message stay' : 'messages stay'} in the original chat.`;
  }
  if (where === 'in_place') return 'Replaces this reply in the current chat. This cannot be undone.';
  return 'The prompt and this reply are copied to a new chat; the original chat stays exactly as it is.';
}

export function destinationNote(mode: BranchMode, where: BranchWhere = 'new'): string {
  if (where === 'in_place') return 'The current chat is rewritten from your prompt.';
  if (mode === 'edit') return 'A new chat starts from the same context, with your edited message.';
  if (mode === 'regenerate') return 'A new chat starts from the same context and asks the same prompt again.';
  return 'A new chat starts from this point.';
}

export function defaultBranchTitle(parentTitle: string, mode: BranchMode): string {
  const base = (parentTitle || 'Chat').trim() || 'Chat';
  const suffix = mode === 'edit' ? 'edit' : mode === 'regenerate' ? 'regenerate' : 'branch';
  const room = Math.max(1, 80 - suffix.length - 3);
  return `${base.slice(0, room).trimEnd()} · ${suffix}`;
}

export function ancestryLabel(branch: ChatBranch | null | undefined, childCount = 0): string {
  if (!branch) return childCount ? `${childCount} ${childCount === 1 ? 'branch' : 'branches'}` : '';
  const title = branch.parent_title || 'the original chat';
  return `Branched from ${title}`;
}

export function branchChildrenLabel(children: NonNullable<BranchState['children']>): string {
  if (!children.length) return '';
  return children.length === 1 ? '1 branch' : `${children.length} branches`;
}

/** A stable operation id for one sheet attempt; retries reuse it so the server can dedupe. */
export function newOperationId(): string {
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 12);
  return `br-${time}-${random}`.slice(0, 96);
}

export function modelLabel(model: BranchState['model']): string {
  if (!model) return '';
  const name = model.label || [model.provider, model.model].filter(Boolean).join(' · ');
  return name || '';
}

export function isBranchChat(chat: Pick<Chat, 'branch'> | null | undefined): boolean {
  return !!chat?.branch;
}
