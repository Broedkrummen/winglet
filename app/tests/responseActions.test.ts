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
  const state: any = { drafts: {}, draftFiles: {}, replyTo: {}, toast: (t: any) => toasts.push(t),
    setDraft: (server: string, chat: string, text: string) => { state.drafts[`${server}:${chat}`] = text; },
    updateDraftFiles: (server: string, chat: string, fn: any) => { const key = `${server}:${chat}`; state.draftFiles[key] = fn(state.draftFiles[key] ?? []); },
    setReplyTo: (server: string, chat: string, reply: any) => { state.replyTo[`${server}:${chat}`] = reply; } };
  const jsx = (type: any, props: any) => ({ type, props });
  const modules: Record<string, any> = {
    react: { memo: (fn: any) => fn, useState: (value: any) => { const i = cursor++; if (!(i in states)) states[i] = value; return [states[i], (v: any) => { states[i] = v; }]; }, useEffect: () => undefined },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'expo-clipboard': { setStringAsync: async (text: string) => { if (fails) throw new Error('Unavailable'); copied.push(text); } },
    '../lib/store': { useApp: { getState: () => state } },
    '../lib/api': { mediaUrl: (_server: any, url: string) => url },
    '../lib/themeContext': { makeStyles: () => () => fallback, useTheme: () => fallback },
    './ui': { Tap: 'Tap', IconButton: 'IconButton' },
  };
  const exports: any = {};
  const source = readFileSync(new URL('../src/components/ChatView.tsx', import.meta.url), 'utf8') + '\nexport { HoverBar, editAgain };';
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText,
    { exports, require: (id: string) => modules[id] ?? fallback });
  const render = (text: string) => { cursor = 0; return exports.HoverBar({ message: { text }, serverId: 'bot', actions: {}, inline: true }); };
  return { render, copied, toasts, state, edit: (message: any, failed = true) => exports.editAgain({ id: 'bot' }, message, failed) };
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

test('editing an old or failed message cannot overwrite another unsent draft or reply', () => {
  const h = harness();
  const message = { chat_id: 'chat', text: 'Old prompt', meta: {} };
  h.state.drafts['bot:chat'] = 'New unsent work';
  assert.equal(h.edit(message), false);
  assert.equal(h.state.drafts['bot:chat'], 'New unsent work');
  assert.equal(h.toasts[0].title, 'You have an unsent draft');
  h.state.drafts['bot:chat'] = '';
  h.state.replyTo['bot:chat'] = { id: 'another-question' };
  assert.equal(h.edit(message), false);
  assert.equal(h.state.replyTo['bot:chat'].id, 'another-question');
});

test('recovering a failed message restores its files once and retains other attached files', () => {
  const h = harness();
  const upload = { id: 'uploaded-file', name: 'report.pdf', kind: 'file', url: '/media/report' };
  h.state.draftFiles['bot:chat'] = [{ localId: 'original-pick', upload }, { localId: 'other', upload: { id: 'keep' } }];
  const message = { chat_id: 'chat', text: 'Read this', meta: { attachments: [upload] } };
  assert.equal(h.edit(message), true);
  assert.equal(h.edit(message), true);
  assert.equal(h.state.drafts['bot:chat'], 'Read this');
  assert.equal(h.state.draftFiles['bot:chat'].length, 2);
  assert.equal(h.state.draftFiles['bot:chat'].filter((file: any) => file.upload.id === 'uploaded-file').length, 1);
});
