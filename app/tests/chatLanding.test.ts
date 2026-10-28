import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { chatKey } from '../src/lib/chatOrganization.ts';

const fallback: any = new Proxy(function () {}, { get: (_t, key) => key === 'then' ? undefined : key === Symbol.toPrimitive ? () => 0 : fallback, apply: () => fallback });
function harness() {
  let cursor = 0;
  const hooks: any[] = [];
  const jsx = (type: any, props: any) => ({ type, props });
  const runtime: any = { status: 'online', chats: { general: { id: 'general', title: 'Main', kind: 'chat' }, fresh: { id: 'fresh', title: 'New topic', kind: 'chat' } },
    messages: { general: [{ id: 'old', text: 'Previous history' }] }, loaded: { general: true }, typing: {} };
  const st: any = { runtime: { bot: runtime }, network: {}, hydrateChat: () => {}, setVisibleChat: () => {}, setReplyTo: () => {} };
  const modules: Record<string, any> = {
    react: { memo: (fn: any) => fn, useCallback: (fn: any) => fn, useMemo: (fn: any) => fn(), useEffect: () => {},
      useState: (value: any) => { const i = cursor++; if (!(i in hooks)) hooks[i] = value; return [hooks[i], (next: any) => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; }]; },
      useRef: (value: any) => { const i = cursor++; return hooks[i] ??= { current: value }; } },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Platform: { OS: 'web' }, View: 'View', StyleSheet: { absoluteFill: {}, hairlineWidth: 1 } },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    '../lib/themeContext': { makeStyles: () => () => fallback, useTheme: () => fallback },
    '../lib/motion': { useReducedMotion: () => true },
    '../lib/chatOrganization': { chatKey },
    '../lib/store': { useApp: Object.assign((select: any) => select(st), { getState: () => st }), useServerState: () => runtime, isTyping: () => false, homeChat: () => 'general' },
    '../lib/connection': { connectionView: () => ({ kind: 'online' }) },
    '../lib/focus': { useFocusRequest: () => null },
    '../lib/modelSheet': { useModelSheet: () => undefined },
    '../lib/messages': { chatMessages: (messages: any[]) => messages },
    './Goal': { useChatGoal: () => ({ goal: null, refresh: () => {}, supported: false }) },
    './Composer': { Composer: 'Composer' }, './ChatPet': { ChatPet: 'ChatPet' },
  };
  const result: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/ChatView.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, { exports: result, require: (name: string) => modules[name] ?? fallback });
  const render = (chatId = 'general', keyboard = false, action?: any) => {
    cursor = 0;
    return result.ChatView({ server: { id: 'bot', bot: { title: 'Atlas' } }, chatId,
      landing: { title: 'Atlas', dock: (props: any) => jsx('Dock', props), action,
        prepareChat: chatId === 'local:new-chat' ? async () => 'fresh' : undefined } }).props.children(keyboard);
  };
  return { render, runtime };
}
function find(tree: any, match: (node: any) => boolean): any {
  if (!tree || typeof tree !== 'object') return;
  if (match(tree)) return tree;
  for (const child of [tree.props?.children].flat(Infinity)) { const result = find(child, match); if (result) return result; }
}
const type = (tree: any, name: string) => find(tree, (node) => node.type === name || node.type?.name === name);

test('first send reveals all previous history in the same chat view and keeps ordinary history paging', () => {
  const h = harness();
  let tree = h.render();
  assert.equal(type(tree, 'MessageList'), undefined);
  type(tree, 'Composer').props.onBeforeSend('general');
  h.runtime.messages.general.push({ id: 'new', text: 'hi' });
  tree = h.render();
  assert.deepEqual(type(tree, 'MessageList').props.messages.map((m: any) => m.id), ['old', 'new']);
  assert.equal(type(tree, 'MessageList').props.allowHistory, undefined);
  assert.equal(type(tree, 'Composer').props.chatId, 'general');
  assert.equal(type(tree, 'Dock'), undefined, 'conversation has no carousel subtree to draw over messages');
});

test('focusing the composer commits the selected pet and hides the dock; blur restores the unused landing', () => {
  const h = harness();
  let tree = h.render();
  type(tree, 'Composer').props.onFocusChange(true);
  tree = h.render('general', true);
  assert.equal(type(tree, 'Dock').props.focused, true);
  tree.props.onLayout({ nativeEvent: { layout: { width: 390 } } });
  tree = h.render('general', true);
  assert.equal(type(tree, 'ChatPet').props.active, true);
  type(tree, 'Composer').props.onFocusChange(false);
  assert.equal(type(h.render(), 'Dock').props.focused, false);
});

test('an Add bot action remains inside the same shell without a composer or forced bot selection', () => {
  const h = harness();
  const tree = h.render('general', false, 'Add button');
  assert.equal(type(tree, 'Composer'), undefined);
  assert.equal(type(tree, 'MessageList'), undefined);
  assert.equal(type(tree, 'Dock').props.focused, false);
});

test('a resolved New chat reveals its own messages without showing the main chat history', () => {
  const h = harness();
  type(h.render('local:new-chat'), 'Composer').props.onBeforeSend('fresh');
  h.runtime.messages.fresh = [{ id: 'new-topic', text: 'New topic' }];
  const tree = h.render('fresh');
  assert.deepEqual(type(tree, 'MessageList').props.messages.map((m: any) => m.id), ['new-topic']);
  assert.equal(type(tree, 'Dock'), undefined);
});

test('keyboard dismissal and a stopped or failed send cannot bring the carousel back over the conversation', () => {
  const h = harness();
  let tree = h.render();
  tree.props.onLayout({ nativeEvent: { layout: { width: 390 } } });
  type(tree, 'Composer').props.onBeforeSend('general');
  h.runtime.messages.general.push({ id: 'queued', text: 'hi', status: 'failed' });
  tree = h.render('general', true);
  assert.equal(type(tree, 'Dock'), undefined);
  type(tree, 'Composer').props.onBeforeSend('general');
  h.runtime.messages.general.push({ id: 'stop', text: '/stop' }, { id: 'stopped', text: 'Stopped' });
  type(tree, 'Composer').props.onFocusChange(false);
  tree = h.render('general', false);
  assert.ok(type(tree, 'MessageList'));
  assert.equal(type(tree, 'Dock'), undefined);
  assert.equal(type(tree, 'ChatPet').props.active, true);
});
