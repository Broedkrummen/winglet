import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOrder, EMPTY_PROJECTS, matchesProjectSearch, movedOrder, projectChatIds, projectChats,
  projectCountLabel, projectIndex, projectOf, readSnapshot, reorderableIds, splitProjects } from '../src/features/projects/logic.ts';
import type { Chat, Project, ProjectSnapshot } from '../src/lib/types.ts';

const project = (id: string, position: number, extra: Partial<Project> = {}): Project => ({
  id, name: id, position, archived: false, revision: 1, private: false, can_manage: true, chat_count: 0,
  created_at: 1, updated_at: 1, ...extra,
});
const chat = (id: string, updated_at = 1, kind: Chat['kind'] = 'chat'): Chat => ({ id, title: id, kind, created_at: 1,
  updated_at, preview: '' });

test('a malformed or older snapshot cannot break the list', () => {
  assert.deepEqual(readSnapshot(undefined), EMPTY_PROJECTS);
  const snap = readSnapshot({
    projects: [project('a', 1), { id: 'broken' }, null, project('b', 2)],
    threads: [{ chat_id: 'c1', project_id: 'a', position: 5 }, { chat_id: 'c2', project_id: 'gone', position: 1 }, null],
    layout_revision: '4',
  });
  assert.deepEqual(snap.projects.map((p) => p.id), ['a', 'b']);
  assert.deepEqual(snap.threads.map((t) => t.chat_id), ['c1']);
  assert.equal(snap.layout_revision, 4);
});

test('every chat maps to the one project that holds it, and unknown chats map to none', () => {
  const snap: ProjectSnapshot = { projects: [project('a', 1000), project('b', 2000)],
    threads: [{ chat_id: 'c1', project_id: 'a', position: 1000 }, { chat_id: 'c2', project_id: 'b', position: 1000 }],
    layout_revision: 1 };
  const index = projectIndex(snap);
  assert.equal(index.get('c1')?.name, 'a');
  assert.equal(projectOf(snap, 'c2')?.name, 'b');
  assert.equal(projectOf(snap, 'nope'), undefined);
});

test('project chats keep their stable order, skip chats not loaded, and break ties deterministically', () => {
  const snap: ProjectSnapshot = { projects: [project('a', 1000)],
    threads: [{ chat_id: 'second', project_id: 'a', position: 2000 }, { chat_id: 'first', project_id: 'a', position: 1000 },
      { chat_id: 'gone', project_id: 'a', position: 3000 }, { chat_id: 'tie', project_id: 'a', position: 2000 }],
    layout_revision: 1 };
  const chats = { first: chat('first', 1), second: chat('second', 2), tie: chat('tie', 5) };
  assert.deepEqual(projectChats(snap, 'a', chats).map((c) => c.id), ['first', 'tie', 'second']);
  assert.deepEqual([...projectChatIds(snap, 'a')], ['second', 'first', 'gone', 'tie']);
});

test('moving a project up or down is a pure order and stops at the ends', () => {
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(movedOrder(ids, 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(movedOrder(ids, 'b', 1), ['a', 'c', 'b']);
  assert.equal(movedOrder(ids, 'a', -1), null);
  assert.equal(movedOrder(ids, 'c', 1), null);
  assert.equal(movedOrder(ids, 'missing', 1), null);
  assert.deepEqual(applyOrder({ ...EMPTY_PROJECTS, projects: [project('a', 3000), project('b', 1000)] }, ['a', 'b']).projects.map((p) => p.position), [1000, 2000]);
});

test('only the scope a device manages is reorderable, so a member cannot send shared ids', () => {
  const snap: ProjectSnapshot = { projects: [project('shared', 1000, { can_manage: true }), project('mine', 2000, { private: true, can_manage: true })],
    threads: [], layout_revision: 1 };
  assert.deepEqual(reorderableIds(snap, true), ['shared']);
  assert.deepEqual(reorderableIds(snap, false), ['mine']);
});

test('archived projects are a separate group and project search includes title, preview and draft', () => {
  const snap: ProjectSnapshot = { projects: [project('active', 1000), project('old', 2000, { archived: true })],
    threads: [], layout_revision: 1 };
  assert.deepEqual(splitProjects(snap).active.map((p) => p.id), ['active']);
  assert.deepEqual(splitProjects(snap).archived.map((p) => p.id), ['old']);
  assert.ok(matchesProjectSearch({ ...chat('x'), title: 'Launch plan', preview: 'notes' }, 'launch'));
  assert.ok(matchesProjectSearch(chat('x'), 'draft', 'Draft · remember this'));
  assert.ok(!matchesProjectSearch(chat('x'), 'other', 'Draft · remember this'));
});

test('counts read naturally for one and many chats', () => {
  assert.equal(projectCountLabel(project('a', 1, { chat_count: 1 })), '1 chat');
  assert.equal(projectCountLabel(project('a', 1, { chat_count: 0 })), '0 chats');
});
