export type RoomMember = { member_id: string; profile: string; handle: string; display_name: string };
export type RoomAction = { kind: 'approval' | 'retry'; task_id: string; member_id?: string; execution_generation?: number; request_id?: string; summary?: string };
export type Room = {
  id: string; title: string; members: RoomMember[]; archived: boolean; revision: number; readers: string[];
  can_manage: boolean; can_send: boolean; member_write_supported: boolean; unread: boolean; latest: [number, number]; epoch_count: number;
  driver: { running: boolean; working: boolean; blocked: boolean; counts: Record<string, number>; pending_actions: RoomAction[]; turns: {profile:string;status:string}[] };
  available_profiles: RoomBot[];
};
export type RoomBot = { name: string; title: string; served: boolean };
export type RoomEvent = { id: string; seq: number; epoch: number; kind: string; actor: { kind: string; id: string }; created_at: number; payload: Record<string, any> };
export type Cursor = [number, number];
export type RoomPage = { events: RoomEvent[]; cursor: Cursor; older: Cursor | null; has_more: boolean };
export type RoomList = { rooms: Room[]; bots: RoomBot[]; can_create: boolean; member_write_supported: boolean };

/** Explicit addressing, preserving roster order and deduplicating repeated mentions. */
export function recipients(text: string, members: RoomMember[]): RoomMember[] {
  const named = new Set(Array.from(text.matchAll(/@([A-Za-z0-9][A-Za-z0-9._:-]*)/g), x => x[1].toLowerCase()));
  return members.filter(m => named.has('all') || named.has('everyone') || named.has(m.handle.toLowerCase()));
}

export function mergeRoomEvents(existing: RoomEvent[], incoming: RoomEvent[]): RoomEvent[] {
  const unique = new Map(existing.map(event => [event.id, event]));
  incoming.forEach(event => unique.set(event.id, event));
  return [...unique.values()].sort((a, b) => a.epoch - b.epoch || a.seq - b.seq);
}

export function mentionQuery(text: string): string | null {
  return text.match(/(?:^|\s)@([A-Za-z0-9._:-]*)$/)?.[1] ?? null;
}

export function roomLine(event: RoomEvent): string | null {
  if (event.kind.startsWith('message.')) return event.payload.text ?? '';
  if (event.kind === 'turn.failed') return `Could not finish this turn: ${event.payload.error || 'Unknown error'}`;
  if (event.kind === 'turn.cancelled') return `Turn stopped${event.payload.reason ? `: ${event.payload.reason}` : '.'}`;
  if (event.kind === 'room.stop_requested') return 'Room Stop requested.';
  if (event.kind === 'room.renamed') return `Room renamed to ${event.payload.name}.`;
  if (event.kind === 'turn.settled' && event.payload.passed) return 'Nothing to add.';
  if (event.kind === 'room.activity' && event.payload.status === 'bounded') return 'Discussion reached its turn limit. Send a new addressed message to continue.';
  return null;
}
