export const TOOLS = ['phone_status', 'phone_shared_note', 'phone_location', 'phone_contacts', 'phone_calendar'] as const;
export type Tool = typeof TOOLS[number];
export type Grant = { tool: Tool; scope: string; mode: 'ask' | 'while_open'; enabled: number };
export type PhoneRequest = { id: string; nonce: string; instance_id: string; tool: Tool; args: Record<string, unknown>; ask: boolean;
  mode: 'ask' | 'while_open'; requested_at: number; expires_at: number; bot: { name: string; title: string }; chat: { id: string; title: string } };
export function readRequest(value: any): PhoneRequest | null {
  if (!value || typeof value.instance_id !== 'string' || value.instance_id.length < 16 || value.instance_id.length > 80 || !/^[a-f0-9]{32}$/.test(value.id) || !/^[a-f0-9]{48}$/.test(value.nonce) || !TOOLS.includes(value.tool)
    || !value.args || typeof value.args !== 'object' || Array.isArray(value.args) || typeof value.ask !== 'boolean'
    || !['ask', 'while_open'].includes(value.mode) || !Number.isFinite(value.requested_at) || !Number.isFinite(value.expires_at)
    || value.expires_at <= value.requested_at || value.expires_at - value.requested_at > 121
    || typeof value.bot?.name !== 'string' || typeof value.bot?.title !== 'string' || typeof value.chat?.id !== 'string' || typeof value.chat?.title !== 'string') return null;
  const a = value.args;
  if (value.tool === 'phone_contacts' && (typeof a.query !== 'string' || a.query.trim().length < 2 || a.query.length > 80)) return null;
  if (value.tool === 'phone_calendar' && (!Number.isSafeInteger(a.start_ms) || !Number.isSafeInteger(a.end_ms) || a.start_ms < 0 || a.end_ms <= a.start_ms || a.end_ms - a.start_ms > 31 * 86400000)) return null;
  if (value.tool === 'phone_location' && (typeof a.precise !== 'boolean' || (a.precise && !value.ask))) return null;
  const allowed = value.tool === 'phone_location' ? ['precise'] : value.tool === 'phone_contacts' ? ['query'] : value.tool === 'phone_calendar' ? ['start_ms', 'end_ms'] : [];
  if (Object.keys(a).some(k => !allowed.includes(k))) return null;
  return value;
}
export function permitted(grants: Grant[], request: PhoneRequest, botScope: string, owner: boolean): boolean {
  return grants.some(g => g.tool === request.tool && !!g.enabled && g.mode === request.mode && (g.scope === botScope || (g.scope === '*' && owner)));
}
export type PolicyHooks = { ready: () => boolean; authority: (r: PhoneRequest) => Promise<boolean>;
  send: (event: object) => void; run: (r: PhoneRequest) => Promise<unknown>; cancel: (id: string) => void;
  changed: (requests: PhoneRequest[]) => void; now?: () => number };
/** In-memory only. Every completion checks it still owns the exact pending request. */
export class PhonePolicy {
  private pending = new Map<string, { request: PhoneRequest; deadline: number; state: 'ask' | 'decided' | 'running'; timer: ReturnType<typeof setTimeout> }>();
  private seen = new Set<string>();
  private hooks: PolicyHooks;
  constructor(hooks: PolicyHooks) { this.hooks = hooks; }
  private now() { return this.hooks.now?.() ?? Date.now(); }
  private publish() { this.hooks.changed([...this.pending.values()].filter(p => p.state === 'ask').map(p => p.request)); }
  private live(id: string) { const p = this.pending.get(id); return p && p.deadline > this.now() && this.hooks.ready() ? p : undefined; }
  receive(value: unknown) {
    const r = readRequest(value);
    if (!r || this.seen.has(r.id)) return;
    this.seen.add(r.id);
    if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
    if (!this.hooks.ready() || this.pending.size >= 4) {
      this.hooks.send({ type: 'phone_tool.decision', id: r.id, nonce: r.nonce, allow: false }); return;
    }
    const ttl = Math.min(120000, (r.expires_at-r.requested_at)*1000);
    const p = { request: r, deadline: this.now()+ttl, state: 'ask' as const, timer: setTimeout(() => this.cancel(r.id), ttl) };
    this.pending.set(r.id,p);
    this.publish();
    if (!r.ask) void this.decide(r.id,true);
  }
  async decide(id: string, allow: boolean) {
    const p = this.live(id);
    if (!p) { this.cancel(id); return; }
    if (p.state !== 'ask') return;
    // Mark before awaiting: double taps cannot produce two decisions.
    p.state = 'decided'; this.publish();
    let authorized = false;
    try { authorized = allow && await this.hooks.authority(p.request); } catch { /* fail closed */ }
    if (this.pending.get(id) !== p) return;
    if (!this.live(id)) { this.cancel(id); return; }
    this.hooks.send({ type: 'phone_tool.decision', id, nonce: p.request.nonce, allow: authorized });
    if (!authorized) this.cancel(id);
  }
  async execute(id: string, nonce: string) {
    const p = this.live(id);
    if (!p || p.state !== 'decided' || p.request.nonce !== nonce) return;
    p.state = 'running';
    try {
      if (!await this.hooks.authority(p.request) || this.pending.get(id) !== p || !this.live(id)) throw new Error('revoked');
      const result = await this.hooks.run(p.request);
      if (this.pending.get(id) !== p || !this.live(id)) return;
      if (!await this.hooks.authority(p.request) || this.pending.get(id) !== p || !this.live(id)) throw new Error('revoked');
      this.hooks.send({ type: 'phone_tool.answer', id, nonce, ok: true, result });
    } catch (cause) {
      const error = cause instanceof Error && ['permission','revoked','expired','locked'].includes(cause.message) ? cause.message : 'unavailable';
      if (this.pending.get(id) === p && this.live(id)) this.hooks.send({ type: 'phone_tool.answer', id, nonce, ok: false, error });
    } finally { this.cancel(id); }
  }
  cancel(id: string) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer); this.pending.delete(id); this.hooks.cancel(id); this.publish();
  }
  clear() { for (const id of [...this.pending.keys()]) this.cancel(id); }
}
