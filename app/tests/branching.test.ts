import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ancestryLabel, branchChildrenLabel, canBranch, canEdit, canRegenerate, canReplaceInPlace,
  copiesCount, defaultBranchTitle, isLatestReply, laterCount, newOperationId, settledMessages,
} from '../src/features/branching/plan.ts';
import type { BranchState, Message } from '../src/lib/types.ts';

const msg = (id: string, over: Partial<Message> = {}): Message => ({
  id, chat_id: 'general', role: 'user', text: id, status: 'final', meta: {}, position: 1,
  created_at: 1, updated_at: 1, ...over,
});

const state = (over: Partial<BranchState> = {}): BranchState => ({
  supported: true, revision: 'b-1', busy: false,
  messages: { u1: { role: 'user', can_edit: true, can_branch: true },
              a1: { role: 'bot', can_branch: true, can_regenerate: true } },
  ...over,
});

test('settledMessages excludes offline bubbles, hidden controls and tool progress', () => {
  const rows = [
    msg('u1', { position: 1 }),
    msg('a1', { role: 'bot', text: 'answer', position: 2 }),
    msg('offline', { status: 'failed', position: 3 }),
    msg('hidden', { meta: { hidden: true }, position: 4 }),
    msg('tool', { role: 'bot', text: '🔍 web_search: cats', position: 5 }),
    msg('empty', { role: 'bot', text: '', position: 6 }),
    msg('u2', { position: 7 }),
  ];
  assert.deepEqual(settledMessages(rows).map((m) => m.id), ['u1', 'a1', 'u2']);
});

test('preview counts match the server boundary rules', () => {
  const rows = [
    msg('u1', { position: 1 }), msg('a1', { role: 'bot', position: 2 }),
    msg('u2', { position: 3 }), msg('a2', { role: 'bot', position: 4 }),
  ];
  assert.equal(laterCount(rows, 'u2', 'edit'), 2);
  assert.equal(copiesCount(rows, 'u2', 'edit'), 2);
  assert.equal(laterCount(rows, 'a1', 'branch'), 2);
  assert.equal(copiesCount(rows, 'a1', 'branch'), 2);
  assert.equal(copiesCount(rows, 'a2', 'regenerate'), 2);
  assert.equal(laterCount(rows, 'a2', 'regenerate'), 2);
});

test('capability gates come from the server snapshot', () => {
  const s = state();
  assert.equal(canEdit(s, 'u1'), true);
  assert.equal(canBranch(s, 'a1'), true);
  assert.equal(canRegenerate(s, 'a1'), true);
  assert.equal(canRegenerate(s, 'u1'), false);
  assert.equal(canEdit({ ...s, supported: false }, 'u1'), false);
});

test('in-place replacement is only offered for the newest settled reply', () => {
  const rows = [msg('u1', { position: 1 }), msg('a1', { role: 'bot', position: 2 }),
                msg('u2', { position: 3 }), msg('a2', { role: 'bot', position: 4 })];
  const s = state({ messages: { a1: { role: 'bot', can_regenerate: true }, a2: { role: 'bot', can_regenerate: true } } });
  assert.equal(isLatestReply(rows, 'a2'), true);
  assert.equal(isLatestReply(rows, 'a1'), false);
  assert.equal(canReplaceInPlace(s, rows, rows[3]), true);
  assert.equal(canReplaceInPlace(s, rows, rows[1]), false);
  assert.equal(canReplaceInPlace(s, rows, { ...rows[3], meta: { attachments: [{ url: 'x', name: 'x', mime: 'x', kind: 'file', size: 1 }] } }), false);
});

test('branch titles are readable and capped', () => {
  assert.equal(defaultBranchTitle('Planning', 'edit'), 'Planning · edit');
  assert.ok(defaultBranchTitle('x'.repeat(200), 'regenerate').length <= 80);
});

test('operation ids are stable-shaped', () => {
  for (let i = 0; i < 5; i++) {
    const id = newOperationId();
    assert.match(id, /^[A-Za-z0-9._:-]{16,96}$/);
  }
});

test('ancestry labels name the origin without adding a bubble', () => {
  assert.equal(ancestryLabel({ parent_chat_id: 'p', parent_title: 'Planning', from_message_id: 'm', mode: 'edit', created_at: 1, source_revision: 'b-1' }),
    'Branched from Planning');
  assert.equal(branchChildrenLabel([{ id: 'c1', title: 'A', created_at: 1 }]), '1 branch');
  assert.equal(branchChildrenLabel([{ id: 'c1', title: 'A', created_at: 1 }, { id: 'c2', title: 'B', created_at: 2 }]), '2 branches');
});
