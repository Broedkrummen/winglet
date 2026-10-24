import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityKind, chatMessages, currentTaskActivity, groupActivity, inSheet, isActivity, markFailed, mergeMessages } from '../src/lib/messages.ts';
import type { Message } from '../src/lib/types.ts';

const msg = (id: string, over: Partial<Message> = {}): Message => ({
  id, chat_id: 'general', role: 'bot', text: id, status: 'final', meta: {}, created_at: 1, updated_at: 1, ...over,
});

test('a stale history snapshot does not erase a newer live reply', () => {
  const live = [msg('a'), msg('b', { created_at: 5, updated_at: 5 })];
  const snapshot = [msg('a')]; // taken before "b" arrived over the socket
  assert.deepEqual(mergeMessages(live, snapshot).map((m) => m.id), ['a', 'b']);
});

test('the current task contains only this turn’s activity, ignoring hidden model controls', () => {
  const activity = [msg('old', { meta: { activity: true } }), msg('question', { role: 'user' }),
    msg('read', { meta: { activity: true } }), msg('model-control', { role: 'user', meta: { hidden: true } }),
    msg('search', { meta: { activity: true } })];
  assert.deepEqual(currentTaskActivity(activity).map((m) => m.id), ['read', 'search']);
  assert.deepEqual(currentTaskActivity([...activity, msg('answer')]), []);
  assert.deepEqual(currentTaskActivity([...activity, msg('next', { role: 'user' })]), []);
  assert.equal(currentTaskActivity([]).length, 0);
});

test('the most recently updated copy of a streaming message wins', () => {
  const live = [msg('a', { text: 'Hello world', status: 'final', updated_at: 9 })];
  const snapshot = [msg('a', { text: 'Hel', status: 'streaming', updated_at: 3 })];
  assert.equal(mergeMessages(live, snapshot)[0].text, 'Hello world');
});

test('older pages stay loaded when the latest page is reloaded', () => {
  const current = [msg('old', { created_at: 0 }), msg('a')];
  assert.deepEqual(mergeMessages(current, [msg('a')]).map((m) => m.id), ['old', 'a']);
});

test('confirmed sends replace their optimistic row', () => {
  const optimistic = msg('c-1', { role: 'user', status: 'pending', meta: { client_id: 'c-1' } });
  const server = msg('srv1', { role: 'user', meta: { client_id: 'c-1' } });
  assert.deepEqual(mergeMessages([optimistic], [server]).map((m) => m.id), ['srv1']);
});

test('a send the server already confirmed is never marked failed', () => {
  const confirmed = [msg('srv1', { role: 'user', meta: { client_id: 'c-1' } })];
  assert.equal(markFailed(confirmed, 'c-1')[0].status, 'final');
  const pending = [msg('c-1', { role: 'user', status: 'pending', meta: { client_id: 'c-1' } })];
  assert.equal(markFailed(pending, 'c-1')[0].status, 'failed');
});

test('server positions order equal-timestamp pages and optimistic rows stay last', () => {
  const current = [msg('later', { position: 3 }), msg('c-1', { role: 'user', status: 'pending', created_at: 0 })];
  const incoming = [msg('oldest', { position: 1 }), msg('middle', { position: 2 })];
  assert.deepEqual(mergeMessages(current, incoming).map(m => m.id), ['oldest', 'middle', 'later', 'c-1']);
});

test('older servers still keep older equal-timestamp pages before the current page', () => {
  assert.deepEqual(mergeMessages([msg('later')], [msg('earlier')], [], true).map(m => m.id), ['earlier', 'later']);
});

test('durable deletion removes cached older history without erasing a newer live reply', () => {
  const current = [msg('deleted', { position: 1 }), msg('older', { position: 2 }), msg('live', { position: 4 })];
  const snapshot = [msg('latest', { position: 3 })];
  assert.deepEqual(mergeMessages(current, snapshot, ['deleted']).map(m => m.id), ['older', 'latest', 'live']);
});

test('a stale history response cannot resurrect a live deletion', () => {
  assert.deepEqual(mergeMessages([], [msg('deleted')], ['deleted']), []);
});

test('a merge keeps the same objects for messages that did not change, so their rows do not re-render', () => {
  const a = msg('a', { position: 1 });
  const b = msg('b', { position: 2 });
  const merged = mergeMessages([a, b], [msg('b', { position: 2, text: 'b!', updated_at: 2 })]);
  assert.equal(merged[0], a);
  assert.notEqual(merged[1], b);
  // A copy without a position still gets the one it had.
  const relabeled = mergeMessages([a], [msg('a', { updated_at: 2 })]);
  assert.equal(relabeled[0].position, 1);
});

const say = (id: string, text: string, over: Partial<Message> = {}) => msg(id, { text, ...over });

test("Hermes's tool progress is activity, and so is a status note it keeps updating", () => {
  assert.ok(isActivity(say('a', '🔍 web_search: "cats in space"')));
  assert.ok(isActivity(say('b', '📖 read_file: "notes.md"\n💻 terminal: "ls -la"\n⚡ skill_view...')));
  assert.ok(isActivity(say('c', '🧰 make_bot')));
  assert.ok(isActivity(say('d', 'Context is 80% full', { role: 'system', meta: { status_key: 'ctx' } })));
  assert.ok(isActivity(say('e', 'anything', { meta: { activity: true } })));
});

test('a real reply is never folded away, even one that looks a little like progress', () => {
  assert.ok(!isActivity(say('a', 'Here is what I found.')));
  assert.ok(!isActivity(say('b', '🎉 done')));
  assert.ok(!isActivity(say('c', '✅ Deployed to staging')));
  assert.ok(!isActivity(say('d', '🔍 web_search: "cats"\nThe results show three breeds.')));
  assert.ok(!isActivity(say('e', '🔍 web_search: "cats"', { role: 'user' })));
  assert.ok(!isActivity(say('f', '🔍 web_search: "cats"', { meta: { reply_to: { id: 'x', role: 'user', text: 'hi' } } })));
  assert.ok(!isActivity(say('g', 'Wants to run a command', { role: 'system', meta: { inbox_id: 'i1' } })));
  assert.ok(!isActivity(say('h', 'Only an owner can use that.', { role: 'system' })));
  assert.ok(!isActivity(say('i', 'x', { meta: { activity: true, picker: { id: 'p', kind: 'model', status: 'open', expires_at: 1 } } })));
});

test('runs of activity fold into one entry between the replies', () => {
  const list = [
    say('u', 'find cats', { role: 'user' }),
    say('p1', '🔍 web_search: "cats"'), say('p2', '📖 read_file: "a.md"'),
    say('r', 'Found three.'),
    say('p3', '💻 terminal: "ls"'),
  ];
  const out = groupActivity(list);
  assert.deepEqual(out.map((e) => (e.kind === 'msg' ? e.m.id : `${e.id}+${e.items.length}`)), ['u', 'p1+2', 'r', 'p3+1']);
  assert.equal(groupActivity([]).length, 0);
});

test("the model sheet's pickers stay out of the chat, and only the reasoning card it asked for", () => {
  const picker = (id: string, kind: 'model' | 'choice') => msg(id, { meta: { picker: { id, kind, status: 'open', expires_at: 9 } } });
  assert.ok(!inSheet(picker('m', 'model'), undefined)); // typed by hand: stays in the chat
  assert.ok(!inSheet(picker('c', 'choice'), undefined));
  assert.ok(inSheet(picker('m', 'model'), undefined, 0, true)); // answers the sheet's own /model
  assert.ok(inSheet(picker('c', 'choice'), undefined, 0, true));
  const waiting = { before: ['old'], until: 1000 };
  assert.ok(inSheet(picker('new', 'choice'), waiting, 500));
  assert.ok(!inSheet(picker('old', 'choice'), waiting, 500)); // was already there
  assert.ok(!inSheet(picker('late', 'choice'), waiting, 2000)); // the sheet gave up waiting
  assert.ok(inSheet(picker('new', 'choice'), { ...waiting, claimed: 'new', until: 0 }, 2000)); // claimed stays claimed
  assert.ok(!inSheet(picker('other', 'choice'), { ...waiting, claimed: 'new' }, 500));
  assert.ok(!inSheet(say('t', 'hi'), waiting, 500));
});

test('the chat keeps a picker typed by hand and drops the ones the sheet asked for', () => {
  const picker = (id: string, kind: 'model' | 'choice' | 'confirm') => msg(id, { meta: { picker: { id, kind, status: 'open', expires_at: 9 } } });
  const list = [
    msg('ask1', { role: 'user', text: '/model', meta: { hidden: true } }), picker('m1', 'model'),
    msg('ask2', { role: 'user', text: '/model' }), picker('m2', 'model'),
    msg('ask3', { role: 'user', text: '/reasoning', meta: { hidden: true } }), picker('r1', 'choice'), picker('x', 'confirm'),
    msg('hi', { role: 'user', text: 'hi' }), say('reply', 'Hello'),
  ];
  assert.deepEqual(chatMessages(list, undefined).map((m) => m.id), ['ask2', 'm2', 'x', 'hi', 'reply']);
  assert.deepEqual(chatMessages([], undefined), []);
});

test('repeated tool lines still count as progress', () => {
  assert.ok(isActivity(say('a', '🔍 web_search: "cats" (×3)')));
  assert.ok(isActivity(say('b', '⚡ read_file... (×2)')));
});

test("Hermes's friendly wording folds only where an answer follows it", () => {
  const friendly = say('p', '🔍 Searching the web for cats in space\n📖 Reading skill pdf');
  assert.equal(activityKind(friendly), 'maybe');
  assert.ok(!isActivity(friendly)); // not certain on its own
  const ids = (list: Message[], typing = false) => groupActivity(list, typing).map((e) => (e.kind === 'msg' ? e.m.id : `${e.id}+${e.items.length}`));
  const u = say('u', 'find cats', { role: 'user' });
  const answer = say('r', 'There are three breeds.');
  assert.deepEqual(ids([u, friendly, answer]), ['u', 'p+1', 'r']); // the answer came
  assert.deepEqual(ids([u, friendly], true), ['u', 'p+1']); // still working on it
  assert.deepEqual(ids([u, friendly]), ['u', 'p']); // ended on it: it may be the answer, so it shows
  assert.deepEqual(ids([u, friendly, say('u2', 'thanks', { role: 'user' })], true), ['u', 'p', 'u2']); // an old turn that ended on it
});

test('an answer that merely starts like progress is not folded', () => {
  const u = say('u', 'status?', { role: 'user' });
  for (const text of ['📖 Reading is fun, but the report says otherwise.\nIt is done.', '🎉 Running late, sorry!\nHere you go.', '✅ Writing the file took a while']) {
    const m = say('a', text);
    // all lines must look like progress; the second line of the first two doesn't, the third is a lone line
    const out = groupActivity([u, m, say('b', 'Done.')]).map((e) => e.kind);
    if (text.includes('\n')) assert.deepEqual(out, ['msg', 'msg', 'msg']);
    else assert.equal(activityKind(m), 'maybe'); // alone it can't be told apart; it folds only with an answer after it
  }
});

test('a reply still streaming in is not taken for friendly progress, even if its first line reads like it', () => {
  const u = say('u', 'what should I read?', { role: 'user' });
  const streaming = say('a', '📖 Reading list for this week', { status: 'streaming' });
  assert.equal(activityKind(streaming), null);
  assert.deepEqual(groupActivity([u, streaming], true).map((e) => e.kind), ['msg', 'msg']);
  // Tool lines with the tool's own name are progress however they arrive.
  assert.equal(activityKind(say('p', '🔍 web_search: "cats"', { status: 'streaming' })), 'sure');
});
