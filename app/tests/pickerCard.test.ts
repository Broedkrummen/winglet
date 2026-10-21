import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import * as models from '../src/lib/modelOptions.ts';

const any: any = new Proxy(function () {}, { get: (_t, key) => key === 'then' ? undefined : key === Symbol.toPrimitive ? () => 0 : any, apply: () => any });
const find = (node: any, predicate: (node: any) => boolean): any[] => {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((n) => find(n, predicate));
  return [...(predicate(node) ? [node] : []), ...find(node.props?.children, predicate)];
};

function harness(request: (...args: any[]) => Promise<any>) {
  let cursor = 0;
  const states: any[] = [];
  const timers: (() => void)[] = [];
  const toasts: any[] = [];
  let now = 1000;
  const jsx = (type: any, props: any) => ({ type, props });
  const app: any = (select: any) => select({ runtime: { bot: {} } });
  app.getState = () => ({ toast: (t: any) => toasts.push(t) });
  const modules: Record<string, any> = {
    react: {
      useState: (value: any) => { const i = cursor++; if (!(i in states)) states[i] = value; return [states[i], (next: any) => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
      useRef: (value: any) => { const i = cursor++; if (!(i in states)) states[i] = { current: value }; return states[i]; },
      useMemo: (fn: any) => fn(), useEffect: () => undefined,
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Pressable: 'Pressable', View: 'View', Text: 'Text', TextInput: 'TextInput', ActivityIndicator: 'Spinner' },
    'react-native-reanimated': { __esModule: true, default: { View: 'Animated.View' } },
    '../lib/modelOptions': models,
    '../lib/motion': { useReducedMotion: () => true },
    '../lib/api': { api: request, ApiError: class extends Error {} },
    '../lib/store': { useApp: app, isOwner: () => true },
    '../lib/themeContext': { makeStyles: () => () => any, useTheme: () => any },
  };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/PickerCard.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, { exports, require: (id: string) => modules[id] ?? any, Date: { now: () => now }, setTimeout: (fn: any) => { timers.push(fn); return timers.length; }, clearTimeout: () => undefined });
  const message = { id: 'm', updated_at: 1, text: 'Choose', meta: { picker: { id: 'p', kind: 'model', status: 'open', expires_at: 60, providers: [{ slug: 'provider', name: 'Provider', models: ['first', 'second'] }] } } };
  const props = { server: { id: 'bot' }, message, presentation: 'sheet' };
  const render = () => { cursor = 0; return exports.PickerCard(props); };
  const choices = () => find(render(), (n) => n.props?.accessibilityRole === 'radio');
  return { render, message, choices, toasts, at: (time: number) => { now = time; }, timers };
}

test('rapid model taps submit only once, and the HTTP response confirms before the socket catches up', async () => {
  let resolve!: (value: any) => void;
  let calls = 0;
  const h = harness(() => { calls++; return new Promise((r) => { resolve = r; }); });
  const rows = h.choices();
  const first = rows[0].props.onPress();
  await rows[1].props.onPress();
  assert.equal(calls, 1);
  resolve({ message: { ...h.message, updated_at: 2, text: 'Model updated', meta: { picker: { ...h.message.meta.picker, status: 'done', selected: 'first' } } } });
  await first;
  assert.equal(h.choices().length, 0);
  assert.ok(JSON.stringify(h.render()).includes('Model updated'));
});

test('an expired model row refuses taps even before the expiry rerender', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return {}; });
  const rows = h.choices();
  h.at(61000);
  await rows[0].props.onPress();
  assert.equal(h.choices().length, 0);
  assert.equal(calls, 0);
});

test('a failed model choice gives feedback and can be retried', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; throw new Error('Offline'); });
  await h.choices()[0].props.onPress();
  assert.equal(h.toasts[0].title, "Couldn't choose");
  await h.choices()[0].props.onPress();
  assert.equal(calls, 2);
});

test('thinking rows preserve the server’s labels and submit its exact choice value', async () => {
  let body: any;
  const h = harness(async (_server, _route, init) => {
    body = JSON.parse(init.body);
    return { message: { ...h.message, updated_at: 2, meta: { picker: { ...(h.message.meta as any).picker, status: 'done' } } } };
  });
  (h.message.meta as any).picker = { id: 'reasoning', kind: 'choice', status: 'open', expires_at: 60,
    choices: [{ value: 'high', label: 'High effort for this session', current: true }, { value: 'ultra', label: 'Ultra (sends max on this route)' }] };
  const rows = find(h.render(), (n) => n.props?.accessibilityLabel === 'Ultra (sends max on this route)');
  assert.equal(rows.length, 1);
  await rows[0].props.onPress();
  assert.deepEqual(body, { value: 'ultra', message_id: 'm' });
});

test('ambiguous display names retain their exact IDs and select the requested snapshot', async () => {
  let body: any;
  const h = harness(async (_server, _route, init) => { body = JSON.parse(init.body); return {}; });
  h.message.meta.picker.providers[0].models = ['claude-sonnet-4-20250101', 'claude-sonnet-4-20250201'];
  const rows = h.choices();
  assert.equal(rows.length, 2);
  assert.ok(JSON.stringify(rows[0]).includes('claude-sonnet-4-20250101'));
  assert.ok(JSON.stringify(rows[1]).includes('claude-sonnet-4-20250201'));
  await rows[1].props.onPress();
  assert.deepEqual(body, { provider: 'provider', model: 'claude-sonnet-4-20250201', message_id: 'm' });
});
