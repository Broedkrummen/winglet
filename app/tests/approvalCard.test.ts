import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const fallback: any = new Proxy(function () {}, { get: (_t, key) => key === 'then' ? undefined : fallback, apply: () => fallback });

function harness() {
  let cursor = 0;
  const states: any[] = [];
  const refs: any[] = [];
  const command = 'first line\n' + 'full command details\n'.repeat(40);
  const item = { id: 'request', kind: 'approval', status: 'pending', body: '', payload: { command, choices: ['once', 'always', 'deny'] } };
  const calls: string[] = [];
  let finish: (() => void) | undefined;
  const store = { runtime: { bot: { inbox: { request: item } } }, respond: async (_server: string, _id: string, reply: any) => { calls.push(reply.choice); await new Promise<void>((resolve) => { finish = resolve; }); } };
  const useApp = Object.assign((select: any) => select(store), { getState: () => store });
  const jsx = (type: any, props: any) => ({ type, props });
  const modules: Record<string, any> = {
    react: {
      useState: (value: any) => { const i = cursor++; if (!(i in states)) states[i] = value; return [states[i], (v: any) => { states[i] = typeof v === 'function' ? v(states[i]) : v; }]; },
      useRef: (value: any) => { const i = cursor++; return refs[i] ??= { current: value }; },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView' },
    '../lib/store': { useApp, isOwner: () => true },
    '../lib/themeContext': { makeStyles: () => () => fallback, useTheme: () => fallback },
    './ui': { Button: 'Button' }, './Sheet': { Sheet: 'Sheet' },
  };
  const exports: any = {};
  const source = readFileSync(new URL('../src/components/InboxCards.tsx', import.meta.url), 'utf8') + '\nexport { ApprovalCard };';
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText,
    { exports, require: (id: string) => modules[id] ?? fallback });
  const render = () => { cursor = 0; return exports.ApprovalCard({ serverId: 'bot', item, compact: true, embedded: true }); };
  return { render, item, calls, command, finish: () => finish?.() };
}

test('expanding a compact approval exposes the full command without responding', () => {
  const h = harness();
  h.render().props.children[1].props.children[1].props.onPress();
  const scroll = h.render().props.children[1].props.children[0];
  assert.equal(scroll.type, 'ScrollView');
  assert.equal(scroll.props.children.props.children, h.command);
  assert.equal(scroll.props.children.props.numberOfLines, undefined);
  assert.deepEqual(h.calls, []);
});

test('Always allow opens confirmation and cannot submit from the first tap', () => {
  const h = harness();
  h.render().props.children[2].props.children.find((b: any) => b.props.title === 'Always allow').props.onPress();
  const sheet = h.render().props.children[3];
  assert.equal(sheet.props.visible, true);
  assert.deepEqual(h.calls, []);
});

test('rapid approval taps submit once; a stale expired request cannot submit', async () => {
  const h = harness();
  const button = h.render().props.children[2].props.children[0];
  const first = button.props.onPress();
  await button.props.onPress();
  assert.deepEqual(h.calls, ['once']);
  h.finish(); await first;
  h.item.status = 'expired';
  await button.props.onPress();
  assert.deepEqual(h.calls, ['once']);
});
