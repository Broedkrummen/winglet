import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatKey, changeChatOrganization, organizeChats } from '../src/lib/chatOrganization.ts';
import type { Chat } from '../src/lib/types.ts';

const chat = (id: string, updated_at: number, kind: Chat['kind'] = 'chat'): Chat => ({ id, title: id, kind, updated_at, created_at: 1, preview: '' });

test('pins precede recent chats, archives are recoverable, and feeds/main chat are excluded', () => {
  const chats = [chat('old-pin', 2), chat('new', 8), chat('old', 1), chat('archive', 10), chat('main', 20), chat('home', 30, 'home')];
  const before = JSON.stringify(chats);
  const result = organizeChats(chats, 'bot', 'main', [chatKey('bot', 'old-pin')], [chatKey('bot', 'archive')]);
  assert.deepEqual(result.pinned.map((c) => c.id), ['old-pin']);
  assert.deepEqual(result.recent.map((c) => c.id), ['new', 'old']);
  assert.deepEqual(result.archived.map((c) => c.id), ['archive']);
  assert.equal(JSON.stringify(chats), before);
});

test('organization cannot bleed between bots or ambiguous IDs', () => {
  assert.notEqual(chatKey('a:b', 'c'), chatKey('a', 'b:c'));
  const result = organizeChats([chat('same', 1)], 'other', 'main', [chatKey('bot', 'same')], [chatKey('bot', 'same')]);
  assert.equal(result.recent.length, 1);
  assert.equal(result.archived.length, 0);
});

test('archive unpins without deleting history; restore returns to recent; repeated actions are idempotent', () => {
  const key = chatKey('bot', 'chat');
  const other = chatKey('bot', 'other');
  const initial = { pinnedChats: [other], archivedChats: [] };
  const pinned = changeChatOrganization(initial, key, 'pin');
  assert.deepEqual(changeChatOrganization(pinned, key, 'pin'), pinned);
  const archived = changeChatOrganization(pinned, key, 'archive');
  assert.deepEqual(archived, { pinnedChats: [other], archivedChats: [key] });
  const restored = changeChatOrganization(archived, key, 'restore');
  assert.deepEqual(restored, initial);
  assert.deepEqual(initial, { pinnedChats: [other], archivedChats: [] });
});

test('archive takes precedence over an old pin and removing a deleted chat cleans both lists', () => {
  const key = chatKey('bot', 'chat');
  const prefs = { pinnedChats: [key], archivedChats: [key] };
  assert.equal(organizeChats([chat('chat', 1)], 'bot', 'main', prefs.pinnedChats, prefs.archivedChats).archived.length, 1);
  assert.deepEqual(changeChatOrganization(prefs, key, 'remove'), { pinnedChats: [], archivedChats: [] });
});
