import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function harness() {
  const requests: any[] = [];
  const downloads: any[] = [];
  const timers: (() => void)[] = [];
  let response = { ok: true, status: 200, text: async () => '# My chat\n\n**Full reply**' };
  function compile(file: string, imports: any) {
    const exports: any = {};
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { exports, require: (id: string) => imports[id] ?? {}, Blob, URL,
      setTimeout: (fn: () => void) => timers.push(fn),
      document: { createElement: () => { const link: any = { click: () => downloads.push({ name: link.download, href: link.href }) }; return link; } } });
    return exports;
  }
  const api = compile('../src/lib/api.ts', {});
  const { exportChat } = compile('../src/lib/exportChat.ts', {
    'react-native': { Platform: { OS: 'web' } }, './api': api,
    'expo/fetch': { fetch: async (url: string, init: any) => { requests.push({ url, init }); return response; } },
  });
  return { exportChat, requests, downloads, timers, fail: () => { response = { ...response, ok: false, status: 403 }; } };
}

test('export selects the same bot as its chat and keeps the full Markdown in a download', async () => {
  const h = harness();
  await h.exportChat({ url: 'https://my-server.test', profile: 'research & writing', token: 'device-token' }, 'chat/one', 'My chat');
  assert.equal(h.requests[0].url, 'https://my-server.test/api/chats/chat%2Fone/export?bot=research%20%26%20writing');
  assert.equal(h.requests[0].init.redirect, 'error');
  assert.equal(h.requests[0].init.headers.Authorization, 'Bearer device-token');
  assert.equal(h.downloads[0].name, 'My chat.md');
  assert.equal(await (await fetch(h.downloads[0].href)).text(), '# My chat\n\n**Full reply**');
  h.timers.forEach((fn) => fn());
});

test('a refused export creates no misleading download', async () => {
  const h = harness();
  h.fail();
  await assert.rejects(h.exportChat({ url: 'https://my-server.test', token: 'device-token' }, 'chat', 'Chat'), /Export failed \(403\)/);
  assert.equal(h.downloads.length, 0);
});
