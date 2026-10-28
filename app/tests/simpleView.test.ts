import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { chatKey } from '../src/lib/chatOrganization.ts';
import { createStore } from 'zustand/vanilla';

const exports: any = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/simpleView.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, require: () => ({ chatKey }) });
const { simpleBotChat, simpleSidebarWidth } = exports;

test('bot opening can resume, go to main, or show the conversation list', () => {
  const chats = { main: { kind: 'chat' }, topic: { kind: 'chat' }, updates: { kind: 'home' } };
  assert.equal(simpleBotChat('bot', 'main', chats, 'topic', 'last', []), 'topic');
  assert.equal(simpleBotChat('bot', 'main', chats, 'topic', 'main', []), 'main');
  assert.equal(simpleBotChat('bot', 'main', chats, 'topic', 'list', []), undefined);
  assert.equal(simpleBotChat('bot', 'main', chats, 'deleted', 'last', []), 'main');
  assert.equal(simpleBotChat('bot', 'main', chats, 'updates', 'last', []), 'main');
  assert.equal(simpleBotChat('bot', 'main', chats, 'topic', 'last', [chatKey('bot', 'topic')]), 'main');
  assert.equal(simpleBotChat('bot', 'main', chats, 'topic', 'last', [chatKey('other', 'topic')]), 'topic');
  assert.equal(simpleBotChat('bot', 'main', undefined, 'topic', 'last', []), 'main');
});

test('large text and narrow screens turn the bot sidebar into a drawer', () => {
  assert.equal(simpleSidebarWidth(1440), 280);
  assert.equal(simpleSidebarWidth(900), 280);
  assert.equal(simpleSidebarWidth(899), 0);
  assert.equal(simpleSidebarWidth(390), 0);
  assert.equal(simpleSidebarWidth(1100, 1.3), 0);
});

test('existing preferences default to Full and view/opening choices survive reloads', async () => {
  let saved: any = { theme: 'dark', layout: 'compact', busyMode: 'steer' };
  const load = () => {
    const result: any = {};
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/prefs.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { exports: result, require: (name: string) => name === 'zustand' ? { create: createStore } : {
      getJSON: async () => saved, setJSON: async (_key: string, value: any) => { saved = structuredClone(value); },
    } });
    return result.usePrefs;
  };
  const prefs = load(); await prefs.getState().load();
  assert.equal(prefs.getState().prefs.view, 'full');
  prefs.getState().update({ view: 'simple', botOpening: 'list', lastChatByBot: { bot: 'topic' } });
  const restored = load(); await restored.getState().load();
  assert.equal(restored.getState().prefs.view, 'simple');
  assert.equal(restored.getState().prefs.botOpening, 'list');
  assert.equal(restored.getState().prefs.lastChatByBot.bot, 'topic');
  assert.equal(restored.getState().prefs.layout, 'compact');
  assert.equal(restored.getState().prefs.busyMode, 'steer');
});
