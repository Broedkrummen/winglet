/** Structured task activity, as the server reports it (`plugin/execution.py`). */

export type TaskState = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type SubagentState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unwatched' | 'unknown';
export type ToolState = 'running' | 'completed' | 'failed' | 'unknown';
export type PlanItemState = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export type PlanItem = { id: string; content: string; status: PlanItemState; parent: string | null };

export type PlanSnapshot = { revision: number; items: PlanItem[]; live?: boolean };

export type ToolSnapshot = {
  id: string;
  name: string;
  preview: string;
  status: ToolState;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  error: string | null;
  /** false when Hermes's start was never seen: the row exists from its finish only. */
  started_known: boolean;
};

export type SubagentActivity = { name: string; detail?: string; status: ToolState };

export type SubagentSnapshot = {
  id: string;
  parent_id: string | null;
  goal: string;
  role: string;
  status: SubagentState;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  summary: string | null;
  tool_count: number | null;
  started_known: boolean;
  activity: SubagentActivity[];
};

export type TaskSnapshot = {
  chat_id: string;
  bot: string | null;
  /** Hermes's turn id, or null when this Hermes did not supply one. */
  turn_id: string | null;
  /** A server-local counter, so a new turn is detectable even without a turn id. */
  turn_index: number;
  task_id: string | null;
  state: TaskState;
  started_at: number | null;
  ended_at: number | null;
  updated_at: number;
  reason: string | null;
  outcome: { state: TaskState; summary: string | null } | null;
  plan: PlanSnapshot | null;
  tools: ToolSnapshot[];
  subagents: SubagentSnapshot[];
  counts: { tools: number; subagents: number; plan_done: number; plan_total: number };
  seq: number;
};

export type TaskEventKind = 'turn.started' | 'turn.finished' | 'plan.updated' | 'tool.started'
  | 'tool.finished' | 'subagent.started' | 'subagent.finished' | 'subagent.updated';

export type TaskEvent = {
  kind: TaskEventKind;
  tool?: ToolSnapshot;
  subagent?: SubagentSnapshot;
  plan?: PlanSnapshot;
  state?: TaskState;
  reason?: string | null;
  outcome?: { state: TaskState; summary: string | null } | null;
};

export type TaskEnvelope = {
  chat_id: string;
  turn_id: string | null;
  turn_index: number;
  seq: number;
  event: TaskEvent;
};

export type TaskCapabilities = { subagent_stop: boolean };

/** Bounded lists, mirroring the server's own caps so a hostile or buggy server cannot grow the app. */
export const MAX_TOOLS = 40;
export const MAX_SUBAGENTS = 40;
export const MAX_ACTIVITY = 12;

/** A running task whose last fact is older than this, in a chat that is no longer busy, is unconfirmed. */
export const UNCONFIRMED_MS = 25_000;

const TERMINAL: TaskState[] = ['completed', 'failed', 'cancelled'];

export const isTerminal = (state: TaskState | undefined) => !!state && TERMINAL.includes(state);
export const isSubagentLive = (state: SubagentState) => state === 'running' || state === 'queued';

export function emptyTask(chatId: string, now = Date.now()): TaskSnapshot {
  return {
    chat_id: chatId, bot: null, turn_id: null, turn_index: 0, task_id: null, state: 'unknown',
    started_at: null, ended_at: null, updated_at: now / 1000, reason: null, outcome: null, plan: null,
    tools: [], subagents: [], counts: { tools: 0, subagents: 0, plan_done: 0, plan_total: 0 }, seq: 0,
  };
}

/** A row identity for the turn: Hermes's id when it gave one, else the server's local counter. */
export function turnKey(snapshot: Pick<TaskSnapshot, 'turn_id' | 'turn_index'> | undefined): string {
  if (!snapshot) return '';
  return snapshot.turn_id ?? `#${snapshot.turn_index}`;
}

const sameTurn = (a: Pick<TaskSnapshot, 'turn_id' | 'turn_index'>, b: Pick<TaskSnapshot, 'turn_id' | 'turn_index'>) =>
  a.turn_index === b.turn_index && (a.turn_id ?? null) === (b.turn_id ?? null);

/** Events and snapshots older than what we hold are dropped, so a late fetch cannot undo live state. */
function newerThan(current: TaskSnapshot | undefined, turnIndex: number, seq: number): boolean {
  if (!current) return true;
  if (turnIndex > current.turn_index) return true;
  if (turnIndex < current.turn_index) return false;
  return seq > current.seq;
}

function bound<T>(list: T[], limit: number): T[] {
  return list.length > limit ? list.slice(-limit) : list;
}

function countsFor(plan: PlanSnapshot | null, tools: ToolSnapshot[], subagents: SubagentSnapshot[]) {
  const items = plan?.items ?? [];
  return {
    tools: tools.length, subagents: subagents.length,
    plan_done: items.filter((item) => item.status === 'completed').length,
    plan_total: items.filter((item) => item.status !== 'cancelled').length,
  };
}

/** The server's snapshot replaces ours only when it is at least as new. */
export function applySnapshot(current: TaskSnapshot | undefined, incoming: TaskSnapshot): TaskSnapshot {
  if (!incoming || typeof incoming.turn_index !== 'number') return current ?? emptyTask(incoming?.chat_id ?? '');
  if (current && current.chat_id === incoming.chat_id) {
    if (incoming.turn_index < current.turn_index) return current;
    // A snapshot at or past our point is authoritative; an earlier one (a slow refetch) is not.
    if (incoming.turn_index === current.turn_index && incoming.seq < current.seq) return current;
  }
  const plan = incoming.plan ? { ...incoming.plan, items: bound(incoming.plan.items ?? [], 256) } : null;
  return {
    ...incoming,
    plan,
    tools: bound(incoming.tools ?? [], MAX_TOOLS),
    subagents: bound((incoming.subagents ?? []).map((sub) => ({ ...sub, activity: bound(sub.activity ?? [], MAX_ACTIVITY) })), MAX_SUBAGENTS),
    counts: incoming.counts ?? countsFor(plan, incoming.tools ?? [], incoming.subagents ?? []),
  };
}

/** One incremental fact folded into the chat's snapshot. Repeated delivery is a no-op. */
export function applyEvent(current: TaskSnapshot | undefined, envelope: TaskEnvelope): TaskSnapshot {
  const { event, seq, turn_index, turn_id, chat_id } = envelope;
  if (current && current.chat_id === chat_id && !newerThan(current, turn_index, seq)) return current;

  const base: TaskSnapshot = !current || current.chat_id !== chat_id || turn_index > current.turn_index
    ? { ...emptyTask(chat_id), turn_index, turn_id: turn_id ?? null, seq }
    : { ...current, seq };
  if (event.kind === 'turn.started') return { ...base, state: 'running' };

  const next: TaskSnapshot = { ...base };
  switch (event.kind) {
    case 'tool.started':
    case 'tool.finished': {
      const tool = event.tool;
      if (!tool) break;
      const tools = next.tools.slice();
      const at = tools.findIndex((row) => row.id === tool.id);
      if (at >= 0) tools[at] = { ...tools[at], ...tool };
      else tools.push(tool);
      next.tools = bound(tools, MAX_TOOLS);
      break;
    }
    case 'subagent.started':
    case 'subagent.finished':
    case 'subagent.updated': {
      const sub = event.subagent;
      if (!sub) break;
      const subs = next.subagents.slice();
      const at = subs.findIndex((row) => row.id === sub.id);
      if (at >= 0) {
        const merged = { ...subs[at], ...sub };
        // A finish that arrives before a start must not claim the child started now.
        if (!subs[at].started_known && sub.started_known === false) merged.started_at = null;
        subs[at] = merged;
      } else {
        subs.push({ ...sub, activity: bound(sub.activity ?? [], MAX_ACTIVITY) });
      }
      next.subagents = bound(subs, MAX_SUBAGENTS);
      break;
    }
    case 'plan.updated': {
      const plan = event.plan;
      if (!plan) break;
      if (next.plan && plan.revision < next.plan.revision) break;
      next.plan = { ...plan, items: bound(plan.items ?? [], 256) };
      break;
    }
    case 'turn.finished': {
      next.state = event.state ?? 'unknown';
      next.ended_at = next.ended_at ?? Date.now() / 1000;
      next.reason = event.reason ?? null;
      next.outcome = event.outcome ?? { state: next.state, summary: null };
      next.subagents = next.subagents.map((sub) => isSubagentLive(sub.status)
        ? { ...sub, status: 'unknown' as SubagentState, ended_at: sub.ended_at ?? next.ended_at }
        : sub);
      next.tools = next.tools.map((tool) => tool.status === 'running'
        ? { ...tool, status: 'unknown' as ToolState, ended_at: tool.ended_at ?? next.ended_at }
        : tool);
      break;
    }
  }
  next.counts = countsFor(next.plan, next.tools, next.subagents);
  return next;
}

/** What the sheet should say. A running task in an idle chat with no fresh fact is not called running. */
export function taskState(snapshot: TaskSnapshot | undefined, busy: boolean, now = Date.now()): TaskState | null {
  if (!snapshot || snapshot.turn_index === 0) return null;
  if (snapshot.state === 'running' && !busy && now - snapshot.updated_at * 1000 > UNCONFIRMED_MS) return 'unknown';
  return snapshot.state;
}

/**
 * Whether the strip belongs on screen: while work is running, while a request waits, or briefly after
 * the turn ends. A running snapshot in an idle chat is shown too, so a turn that never reported an end
 * can say "Not confirmed" instead of vanishing.
 */
export function stripVisible(snapshot: TaskSnapshot | undefined, busy: boolean, pending: boolean, expired: boolean,
  now = Date.now()): boolean {
  if (busy || pending) return true;
  if (!snapshot || snapshot.turn_index === 0 || expired) return false;
  if (isTerminal(snapshot.state)) return true;
  if (snapshot.state === 'running') return now - snapshot.updated_at * 1000 < UNCONFIRMED_MS;
  return false;
}

export const stateLabel = (state: TaskState | null): string => ({
  running: 'Working', completed: 'Completed', failed: 'Failed', cancelled: 'Stopped',
  unknown: 'Not confirmed',
}[state ?? 'unknown']);

export function elapsedLabel(snapshot: Pick<TaskSnapshot, 'started_at' | 'ended_at' | 'state'>, now = Date.now()): string | null {
  if (snapshot.started_at == null) return null;
  const end = snapshot.state === 'running' ? now / 1000 : snapshot.ended_at ?? now / 1000;
  const seconds = Math.max(0, Math.round(end - snapshot.started_at));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(s).padStart(2, '0');
}

/** Done over total, ignoring cancelled steps (they are neither done nor outstanding). */
export function planProgress(plan: PlanSnapshot | null | undefined) {
  const items = plan?.items ?? [];
  const done = items.filter((item) => item.status === 'completed').length;
  const total = items.filter((item) => item.status !== 'cancelled').length;
  const current = items.find((item) => item.status === 'in_progress') ?? null;
  return { done, total, current, fraction: total ? done / total : 0 };
}

/**
 * Plan items in reading order with their nesting depth: each under its parent, in list order.
 * A dangling parent or a cycle is shown flat rather than dropping the item (same rule as Herald).
 */
export function planTree(plan: PlanSnapshot | null | undefined): { item: PlanItem; depth: number }[] {
  const items = plan?.items ?? [];
  const ids = new Set(items.map((item) => item.id));
  const children = new Map<string, PlanItem[]>();
  for (const item of items) {
    if (item.parent && ids.has(item.parent)) {
      children.set(item.parent, [...(children.get(item.parent) ?? []), item]);
    }
  }
  const out: { item: PlanItem; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (item: PlanItem, depth: number) => {
    if (seen.has(item.id) || depth > 6) return;
    seen.add(item.id);
    out.push({ item, depth });
    for (const child of children.get(item.id) ?? []) visit(child, depth + 1);
  };
  for (const item of items) if (!item.parent || !ids.has(item.parent)) visit(item, 0);
  for (const item of items) if (!seen.has(item.id)) visit(item, 0);
  return out;
}

/** Active children first so what needs attention is never below a finished list. */
export function orderedSubagents(subagents: SubagentSnapshot[]): SubagentSnapshot[] {
  const rank = (state: SubagentState) => state === 'running' ? 0 : state === 'queued' ? 1 : state === 'unwatched' ? 2
    : state === 'failed' ? 3 : state === 'unknown' ? 4 : 5;
  return subagents.map((sub, i) => ({ sub, i })).sort((a, b) => rank(a.sub.status) - rank(b.sub.status) || a.i - b.i)
    .map(({ sub }) => sub);
}

/** Children of each subagent, bounded against a malformed parent chain. */
export function subagentChildren(subagents: SubagentSnapshot[], parentId: string | null, depth = 0): SubagentSnapshot[] {
  if (depth > 6) return [];
  return subagents.filter((sub) => (sub.parent_id ?? null) === parentId);
}

export const subagentStateLabel = (state: SubagentState): string => ({
  running: 'Running', queued: 'Waiting to start', completed: 'Done', failed: 'Failed', cancelled: 'Stopped',
  unwatched: 'In the background', unknown: 'Not confirmed',
}[state]);

export const toolStateLabel = (state: ToolState): string => ({
  running: 'Running', completed: 'Done', failed: 'Failed', unknown: 'Not confirmed',
}[state]);

export const planStateLabel = (state: PlanItemState, live = true): string => ({
  pending: 'To do', in_progress: live ? 'Doing' : 'Unfinished', completed: 'Done', cancelled: 'Cancelled',
}[state]);

/** "tool · 12s" summary for a tool row; duration only when the server measured it. */
export function durationLabel(ms: number | null | undefined): string | null {
  if (ms == null || ms < 0) return null;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}
