/** Personal composition replication. This queue never contains executable messages. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Value = { deleted: true } | { deleted: false; value: Json };
export type Candidate = Value & { device_id: string; operation_id: string; at: number };
export type RecordState = { revision: number; fields: Record<string, { revision: number; candidates: Candidate[] }> };
export type Kind = 'preferences' | 'draft' | 'organization' | 'bookmark' | 'preset' | 'read_position';
export type Mutation = { operation_id: string; base_revision: number; changes: Record<string, Value>;
  base_fields?: Record<string, number>; resolve?: boolean };
export type Pending = { kind: Kind; id: string; mutation: Mutation; predecessors: Record<string, string>; prepared: boolean };
export type Replica = { version: 1; records: Record<string, RecordState>; pending: Pending[]; receipts: Record<string, RecordState>;
  observed?: Record<string, Record<string, number>>; rejectedResolutions?: Pending[] };
export const emptyReplica = (): Replica => ({ version: 1, records: {}, pending: [], receipts: {} });
export const recordKey = (kind: Kind, id: string) => JSON.stringify([kind, id]);
const emptyRecord = (): RecordState => ({ revision: 0, fields: {} });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const valueKey = (field: Value) => JSON.stringify(field.deleted ? { deleted: true } : { deleted: false, value: field.value },
  (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);

export function validateRecord(record: RecordState): void {
  if (!record || !Number.isSafeInteger(record.revision) || record.revision < 0 || !record.fields
    || typeof record.fields !== 'object' || Array.isArray(record.fields) || Object.keys(record.fields).length > 100)
    throw new Error('The sync home returned an invalid record. Keep local changes and update the server.');
  for (const [name, field] of Object.entries(record.fields)) {
    if (['__proto__', 'prototype', 'constructor'].includes(name) || !field || !Number.isSafeInteger(field.revision)
      || field.revision < 0 || field.revision > record.revision || !Array.isArray(field.candidates)
      || !field.candidates.length || field.candidates.length > 2000
      || field.candidates.some(c => !c || typeof c.deleted !== 'boolean'
        || (!c.deleted && !Object.hasOwn(c, 'value')) || typeof c.device_id !== 'string'
        || typeof c.operation_id !== 'string' || !Number.isFinite(c.at)))
      throw new Error('The sync home returned invalid field history. Keep local changes and update the server.');
  }
}

export function stage(replica: Replica, kind: Kind, id: string, operation: string, changes: Record<string, Value>, resolve = false, coalesce = false): Replica {
  if (!Object.keys(changes).length) return replica;
  changes = Object.fromEntries(Object.entries(changes).map(([field, value]) => [field,
    value.deleted ? { deleted: true } : { deleted: false, value: value.value }]));
  if (replica.pending.length >= 1000) throw new Error('Sync has 1,000 unsent changes. Reconnect before adding more.');
  const record = replica.records[recordKey(kind, id)] ?? emptyRecord();
  const predecessors: Record<string, string> = {};
  const bases: Record<string, number> = {};
  for (const field of Object.keys(changes)) {
    bases[field] = replica.observed ? replica.observed[recordKey(kind, id)]?.[field] ?? 0 : record.fields[field]?.revision ?? 0;
    if (!resolve) {
      const previous = replica.pending.findLast(p => p.kind === kind && p.id === id && field in p.mutation.changes);
      if (previous) predecessors[field] = previous.mutation.operation_id;
    }
  }
  const pending: Pending = { kind, id, predecessors, prepared: false,
    mutation: { operation_id: operation, base_revision: record.revision, base_fields: bases, changes: copy(changes), ...(resolve ? { resolve: true } : {}) } };
  const tail = replica.pending.at(-1);
  if (coalesce && tail && !tail.prepared && !tail.mutation.resolve && !resolve && tail.kind === kind && tail.id === id) {
    const added = Object.keys(changes).filter(field => !(field in tail.mutation.changes));
    const merged: Pending = { ...tail, predecessors: { ...tail.predecessors }, mutation: {
      ...tail.mutation, base_revision: Math.max(tail.mutation.base_revision, record.revision),
      base_fields: { ...tail.mutation.base_fields }, changes: { ...tail.mutation.changes, ...copy(changes) },
    } };
    for (const field of added) {
      merged.mutation.base_fields![field] = bases[field];
      if (predecessors[field]) merged.predecessors[field] = predecessors[field];
    }
    return { ...replica, pending: [...replica.pending.slice(0, -1), merged] };
  }
  return { ...replica, pending: [...replica.pending, pending] };
}

/** Freeze exact request bytes before the first HTTP attempt, including causal local edits. */
export function prepare(replica: Replica): Replica {
  const head = replica.pending[0];
  if (!head || head.prepared) return replica;
  const mutation = copy(head.mutation);
  if (!mutation.resolve) for (const [field, operation] of Object.entries(head.predecessors)) {
    const receipt = replica.receipts[operation];
    if (!receipt) throw new Error('A preceding sync receipt is unavailable. Keep local changes and retry recovery.');
    mutation.base_fields![field] = receipt.fields[field]?.revision ?? 0;
    mutation.base_revision = Math.max(mutation.base_revision, receipt.revision);
  }
  return { ...replica, pending: [{ ...head, mutation, prepared: true }, ...replica.pending.slice(1)] };
}

export function receive(replica: Replica, kind: Kind, id: string, record: RecordState): Replica {
  validateRecord(record);
  const key = recordKey(kind, id);
  if ((replica.records[key]?.revision ?? -1) >= record.revision) return replica;
  return { ...replica, records: { ...replica.records, [key]: copy(record) } };
}

export function acknowledge(replica: Replica, operation: string, record: RecordState): Replica {
  const head = replica.pending[0];
  if (!head || head.mutation.operation_id !== operation) throw new Error('Sync response does not match its pending operation.');
  const accepted = receive(replica, head.kind, head.id, record);
  const pending = accepted.pending.slice(1);
  const receipts = { ...accepted.receipts, [operation]: copy(record) };
  const needed = new Set(pending.flatMap(p => Object.values(p.predecessors)));
  let observed = accepted.observed;
  if (observed) {
    const key = recordKey(head.kind, head.id);
    const fields = { ...observed[key] };
    for (const [field, intent] of Object.entries(head.mutation.changes)) {
      const outcome = record.fields[field];
      if (outcome?.candidates.length === 1 && valueKey(outcome.candidates[0]) === valueKey(intent))
        fields[field] = Math.max(fields[field] ?? 0, outcome.revision);
    }
    observed = { ...observed, [key]: fields };
  }
  return { ...accepted, observed, pending, receipts: Object.fromEntries(Object.entries(receipts).filter(([key]) => needed.has(key))) };
}

export function visibleValues(replica: Replica, kind: Kind, id: string): Record<string, Value> {
  const record = replica.records[recordKey(kind, id)] ?? emptyRecord();
  const result: Record<string, Value> = {};
  for (const [field, state] of Object.entries(record.fields)) {
    if (state.candidates.length === 1) result[field] = state.candidates[0];
  }
  for (const pending of replica.pending) if (pending.kind === kind && pending.id === id) Object.assign(result, pending.mutation.changes);
  return result;
}

/** Serialize journal edits, but permit typing while a frozen request is in flight. */
export class SyncReplica {
  private queue: Promise<unknown> = Promise.resolve();
  private sending?: Promise<void>;
  private dirty = false;
  state: Replica;
  private save: (value: Replica) => Promise<void>;
  private changed: () => void;
  constructor(state: Replica, save: (value: Replica) => Promise<void>, changed: () => void = () => {}) {
    this.state = state;
    this.save = save;
    this.changed = changed;
  }

  edit(change: (value: Replica) => Replica): Promise<void> {
    const next = this.queue.then(async () => {
      const value = change(this.state);
      if (value === this.state && !this.dirty) return;
      // Retain unsaved intent in memory; the next attempt must commit it before HTTP.
      this.state = value;
      this.dirty = true;
      this.changed();
      await this.save(value);
      this.dirty = false;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Incoming state must wait for local capture writes already queued by the UI. */
  async settle(): Promise<void> { await this.queue; }
  get unsaved(): boolean { return this.dirty; }

  flush(send: (pending: Pending) => Promise<RecordState>): Promise<void> {
    if (this.sending) return this.sending;
    this.sending = this.drain(send).finally(() => { this.sending = undefined; });
    return this.sending;
  }

  private async drain(send: (pending: Pending) => Promise<RecordState>) {
    while (true) {
      await this.edit(prepare);
      const head = this.state.pending[0];
      if (!head) return;
      const result = await send(head);
      await this.edit(state => acknowledge(state, head.mutation.operation_id, result));
    }
  }
}
