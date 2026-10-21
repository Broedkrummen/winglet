import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

function harness() {
  const state: any = { drafts: { 'main:general': 'Keep main draft', 'main:local:new-chat': 'New topic' }, createChat: async () => ({ id: 'fresh' }),
    setDraft: (bot: string, chat: string, text: string) => { state.drafts[`${bot}:${chat}`] = text; }, toast: () => {} };
  const result: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/landingChat.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: result, require: () => ({ draftKey: (bot: string, chat: string) => `${bot}:${chat}`, useApp: { getState: () => state } }) });
  return { state, ...result };
}

test('new-chat target creates once, uses only its bot and transfers the latest draft without touching main', async () => {
  const h = harness();
  let finish: any;
  const calls: string[] = [];
  const resolved: string[] = [];
  h.state.createChat = (bot: string) => { calls.push(bot); return new Promise((r) => { finish = r; }); };
  const target = h.newChatTarget('main', (id: string) => resolved.push(id));
  const first = target();
  const second = target();
  h.state.drafts['main:local:new-chat'] = 'Continued typing';
  finish({ id: 'fresh' });
  assert.equal(await first, 'fresh');
  assert.equal(await second, 'fresh');
  assert.equal(await target(), 'fresh');
  assert.deepEqual(calls, ['main']);
  assert.deepEqual(resolved, ['fresh']);
  assert.equal(h.state.drafts['main:fresh'], 'Continued typing');
  assert.equal(h.state.drafts['main:local:new-chat'], '');
  assert.equal(h.state.drafts['main:general'], 'Keep main draft');
});

test('failed creation preserves the draft and retries without resolving a fake chat', async () => {
  const h = harness();
  let count = 0;
  let errors = 0;
  h.state.createChat = async () => { if (++count === 1) throw new Error('offline'); return { id: 'retry' }; };
  h.state.toast = () => errors++;
  const target = h.newChatTarget('main', () => {});
  assert.equal(await target(), null);
  assert.equal(h.state.drafts['main:local:new-chat'], 'New topic');
  assert.equal(errors, 1);
  assert.equal(await target(), 'retry');
});
