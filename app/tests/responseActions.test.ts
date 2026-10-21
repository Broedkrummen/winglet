import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const fallback: any = new Proxy(function () {}, { get: (_t, key) => key === 'then' ? undefined : key === Symbol.toPrimitive ? () => 0 : fallback, apply: () => fallback });

function harness(fails = false) {
  let cursor = 0;
  const states: any[] = [];
  const copied: string[] = [];
  const toasts: any[] = [];
  const jsx = (type: any, props: any) => ({ type, props });
  const modules: Record<string, any> = {
    react: { memo: (fn: any) => fn, useState: (value: any) => { const i = cursor++; if (!(i in states)) states[i] = value; return [states[i], (v: any) => { states[i] = v; }]; }, useEffect: () => undefined },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'expo-clipboard': { setStringAsync: async (text: string) => { if (fails) throw new Error('Unavailable'); copied.push(text); } },
    '../lib/store': { useApp: { getState: () => ({ toast: (t: any) => toasts.push(t) }) } },
    '../lib/themeContext': { makeStyles: () => () => fallback, useTheme: () => fallback },
    './ui': { Tap: 'Tap', IconButton: 'IconButton' },
  };
  const exports: any = {};
  const source = readFileSync(new URL('../src/components/ChatView.tsx', import.meta.url), 'utf8') + '\nexport { HoverBar };';
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText,
    { exports, require: (id: string) => modules[id] ?? fallback });
  const render = (text: string) => { cursor = 0; return exports.HoverBar({ message: { text }, serverId: 'bot', actions: {}, inline: true }); };
  return { render, copied, toasts };
}

test('visible Copy preserves the complete Markdown response and shows confirmation', async () => {
  const h = harness();
  const text = '**Full reply**\n\n```ts\nconst n = 42;\n```';
  await h.render(text).props.children[0].props.onPress();
  assert.deepEqual(h.copied, [text]);
  assert.equal(h.render(text).props.children[0].props.accessibilityLabel, 'Copied response');
});

test('clipboard failure leaves Copy available and gives a recoverable error', async () => {
  const h = harness(true);
  await h.render('reply').props.children[0].props.onPress();
  assert.equal(h.render('reply').props.children[0].props.accessibilityLabel, 'Copy response');
  assert.equal(h.toasts.length, 1);
  assert.equal(h.copied.length, 0);
});
