import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyEvent, applySnapshot, durationLabel, elapsedLabel, emptyTask, MAX_SUBAGENTS, MAX_TOOLS, orderedSubagents,
  planProgress, planStateLabel, planTree, stateLabel, stripVisible, subagentChildren, taskState, turnKey, isTerminal,
} from '../src/features/execution/model.ts';
import type { SubagentSnapshot, TaskEnvelope, TaskSnapshot, ToolSnapshot } from '../src/features/execution/model.ts';

const tool = (id: string, overrides: Partial<ToolSnapshot> = {}): ToolSnapshot => ({
  id, name: 'terminal', preview: 'echo hi', status: 'running', started_at: 100, ended_at: null,
  duration_ms: null, error: null, started_known: true, ...overrides,
});

const sub = (id: string, overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot => ({
  id, parent_id: null, goal: 'Research', role: 'leaf', status: 'running', started_at: 100,
  ended_at: null, duration_ms: null, summary: null, tool_count: null, started_known: true, activity: [], ...overrides,
});

const snapshot = (overrides: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  ...emptyTask('general'), turn_index: 1, turn_id: 't1', state: 'running', started_at: 100,
  updated_at: 105, seq: 1, ...overrides,
});

const envelope = (overrides: Partial<TaskEnvelope> & Pick<TaskEnvelope, 'event'>): TaskEnvelope => ({
  chat_id: 'general', turn_id: 't1', turn_index: 1, seq: 2, ...overrides,
});

test('a live event is folded once, and a late duplicate cannot undo a newer finish', () => {
  let task = applyEvent(undefined, envelope({ event: { kind: 'tool.started', tool: tool('a') } }));
  assert.equal(task.tools.length, 1);
  task = applyEvent(task, envelope({ seq: 3, event: { kind: 'tool.finished', tool: tool('a', { status: 'failed', error: 'boom' }) } }));
  assert.equal(task.tools[0].status, 'failed');
  const repeated = applyEvent(task, envelope({ seq: 3, event: { kind: 'tool.started', tool: tool('a') } }));
  assert.equal(repeated, task, 'the same seq is a no-op');
  const late = applyEvent(task, envelope({ seq: 2, event: { kind: 'tool.started', tool: tool('b') } }));
  assert.equal(late.tools.length, 1, 'an older fact cannot add a row');
});

test('completion before start keeps one row and never invents a start time', () => {
  const task = applyEvent(undefined, envelope({
    event: { kind: 'tool.finished', tool: tool('a', { status: 'failed', started_at: null, started_known: false,
      ended_at: 120, duration_ms: 900, error: 'timed out' }) },
  }));
  assert.equal(task.tools.length, 1);
  assert.equal(task.tools[0].started_known, false);
  assert.equal(task.tools[0].started_at, null);
  assert.equal(task.tools[0].error, 'timed out');
});

test('a new turn clears the previous plan, tools and subagents; a late event for the old turn is ignored', () => {
  const old = applyEvent(snapshot({ plan: { revision: 2, items: [{ id: '1', content: 'Old', status: 'pending', parent: null }] } }),
    envelope({ seq: 2, event: { kind: 'subagent.started', subagent: sub('sa1') } }));
  const fresh = applyEvent(old, envelope({ turn_index: 2, turn_id: 't2', seq: 1, event: { kind: 'turn.started' } }));
  assert.equal(fresh.turn_id, 't2');
  assert.deepEqual(fresh.subagents, []);
  assert.deepEqual(fresh.tools, []);
  assert.equal(fresh.plan, null);
  const late = applyEvent(fresh, envelope({ turn_index: 1, seq: 9, event: { kind: 'subagent.started', subagent: sub('old') } }));
  assert.equal(late.turn_index, 2);
  assert.deepEqual(late.subagents, []);
});

test('a finished turn marks children still running as unconfirmed, not successful', () => {
  const running = applyEvent(applyEvent(snapshot(), envelope({
    seq: 2, event: { kind: 'subagent.started', subagent: sub('sa1') },
  })), envelope({ seq: 3, event: { kind: 'tool.started', tool: tool('busy') } }));
  const ended = applyEvent(running, envelope({ seq: 4, event: { kind: 'turn.finished', state: 'cancelled', reason: 'You stopped it' } }));
  assert.equal(ended.state, 'cancelled');
  assert.equal(ended.subagents[0].status, 'unknown');
  assert.equal(ended.tools[0].status, 'unknown');
  assert.equal(ended.reason, 'You stopped it');
});

test('a snapshot is accepted only when it is at least as new as live state', () => {
  const live = applyEvent(snapshot(), envelope({ seq: 5, event: { kind: 'tool.started', tool: tool('a') } }));
  const stale = applySnapshot(live, snapshot({ seq: 2 }));
  assert.equal(stale, live);
  const newer = applySnapshot(live, snapshot({ seq: 6, state: 'completed', ended_at: 120 }));
  assert.equal(newer.state, 'completed');
  const nextTurn = applySnapshot(newer, snapshot({ turn_index: 2, turn_id: 't2', seq: 1, state: 'running' }));
  assert.equal(nextTurn.turn_id, 't2');
});

test('the plan keeps revisions honest and refuses a stale write', () => {
  let task = applyEvent(snapshot(), envelope({ seq: 2, event: { kind: 'plan.updated', plan: { revision: 3, items: [
    { id: '1', content: 'One', status: 'completed', parent: null }] } } }));
  task = applyEvent(task, envelope({ seq: 3, event: { kind: 'plan.updated', plan: { revision: 2, items: [
    { id: '2', content: 'Stale', status: 'pending', parent: null }] } } }));
  assert.equal(task.plan?.revision, 3);
  assert.equal(task.plan?.items[0].content, 'One');
});

test('plan rows nest under their parent, cycles stay visible, and cancelled steps do not count as progress', () => {
  const plan = { revision: 1, items: [
    { id: '1', content: 'Parent', status: 'in_progress' as const, parent: null },
    { id: '2', content: 'Child', status: 'completed' as const, parent: '1' },
    { id: '3', content: 'Grandchild', status: 'pending' as const, parent: '2' },
    { id: '4', content: 'Cancelled', status: 'cancelled' as const, parent: null },
    { id: '5', content: 'Loop A', status: 'pending' as const, parent: '6' },
    { id: '6', content: 'Loop B', status: 'pending' as const, parent: '5' },
  ] };
  assert.deepEqual(planTree(plan).map((row) => [row.item.id, row.depth]),
    [['1', 0], ['2', 1], ['3', 2], ['4', 0], ['5', 0], ['6', 1]]);
  const progress = planProgress(plan);
  assert.equal(progress.done, 1);
  assert.equal(progress.total, 5);
  assert.equal(progress.current?.content, 'Parent');
  assert.equal(progress.fraction, 1 / 5);
});

test('active subagents come first and children stay under their parent', () => {
  const rows = [sub('done', { status: 'completed' }), sub('running'), sub('failed', { status: 'failed' }),
    sub('child', { parent_id: 'running', status: 'queued' })];
  assert.deepEqual(orderedSubagents(rows).map((row) => row.id), ['running', 'child', 'failed', 'done']);
  assert.deepEqual(subagentChildren(rows, 'running').map((row) => row.id), ['child']);
  assert.deepEqual(subagentChildren(rows, 'missing'), []);
});

test('a running task in an idle chat becomes unconfirmed instead of claiming to still run', () => {
  const task = snapshot({ updated_at: 1_000 });
  assert.equal(taskState(task, true, 1_500_000), 'running');
  assert.equal(taskState(task, false, 1_000_000), 'running', 'a fresh fact stays running for a moment');
  assert.equal(taskState(task, false, 1_500_000), 'unknown');
  assert.equal(stateLabel('unknown'), 'Not confirmed');
  assert.equal(isTerminal('unknown'), false);
  assert.equal(isTerminal('cancelled'), true);
});

test('elapsed time and durations read as a clock, and an unknown start says nothing', () => {
  assert.equal(elapsedLabel({ started_at: 100, ended_at: null, state: 'running' }, 142_400), '0:42');
  assert.equal(elapsedLabel({ started_at: 100, ended_at: 100 + 3_723, state: 'completed' }, 999_999), '1:02:03');
  assert.equal(elapsedLabel({ started_at: null, ended_at: null, state: 'running' }), null);
  assert.equal(durationLabel(2500), '2.5s');
  assert.equal(durationLabel(12_000), '12s');
  assert.equal(durationLabel(null), null);
});

test('a step still marked in progress after the turn ended reads as unfinished, not working', () => {
  assert.equal(planStateLabel('in_progress', true), 'Doing');
  assert.equal(planStateLabel('in_progress', false), 'Unfinished');
  assert.equal(planStateLabel('completed', false), 'Done');
});

test('turn identity prefers Hermes id and falls back to the server counter only when absent', () => {
  assert.equal(turnKey({ turn_id: 'abc', turn_index: 3 }), 'abc');
  assert.equal(turnKey({ turn_id: null, turn_index: 3 }), '#3');
  assert.equal(turnKey(undefined), '');
});

test('a hostile server cannot grow the app: lists stay bounded', () => {
  let task = snapshot();
  for (let i = 0; i < MAX_TOOLS + 10; i += 1) {
    task = applyEvent(task, envelope({ seq: i + 2, event: { kind: 'tool.started', tool: tool(`t${i}`) } }));
  }
  for (let i = 0; i < MAX_SUBAGENTS + 5; i += 1) {
    task = applyEvent(task, envelope({ seq: MAX_TOOLS + 20 + i, event: { kind: 'subagent.started', subagent: sub(`s${i}`) } }));
  }
  assert.equal(task.tools.length, MAX_TOOLS);
  assert.equal(task.tools.at(-1)?.id, `t${MAX_TOOLS + 9}`);
  assert.equal(task.subagents.length, MAX_SUBAGENTS);
});

test('the strip is shown while working, while a request waits, and briefly for an unresolved end', () => {
  const now = 1_000_000;
  const running = snapshot({ updated_at: 980 });
  assert.equal(stripVisible(running, true, false, true, now), true, 'busy keeps it even after a reconnect');
  assert.equal(stripVisible(undefined, false, true, true, now), true, 'a pending request always has a strip');
  assert.equal(stripVisible(running, false, false, false, now), true, 'a fresh running snapshot says Not confirmed');
  assert.equal(stripVisible(running, false, false, false, now + 30_000), false, 'a stale one does not linger forever');
  assert.equal(stripVisible(snapshot({ state: 'completed', ended_at: 995 }), false, false, false, now), true);
  assert.equal(stripVisible(snapshot({ state: 'completed', ended_at: 995 }), false, false, true, now), false, 'expired');
  assert.equal(stripVisible(emptyTask('general'), false, false, false, now), false, 'no turn yet');
});
