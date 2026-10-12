import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

function harness(over: Record<string, any> = {}) {
  let state: any;
  let downloads = 0;
  let deleted = 0;
  const intents: any[] = [];
  const urls: string[] = [];
  const update = { version: '0.3.0', page: 'https://github.com/releases/v0.3.0', apk: 'https://github.com/update.apk', apkSize: 100 };
  class Directory {
    exists = false;
    create() { this.exists = true; }
  }
  class File {
    exists = false;
    size = 0;
    contentUri = 'content://winglet/updates/winglet-0.3.0.apk';
    delete() { this.exists = false; deleted++; }
    static async downloadFileAsync(url: string, file: File, options: any) {
      downloads++;
      if (over.download) return over.download(url, file, options, state);
      options.onProgress({ bytesWritten: 50, totalBytes: 100 });
      assert.equal(state.progress, 0.5);
      file.exists = true;
      file.size = over.size ?? 100;
      return file;
    }
  }
  const exports: any = {};
  const modules: Record<string, any> = {
    'expo-file-system': { Directory, File, Paths: { cache: 'file:///cache/' } },
    'expo-intent-launcher': { startActivityAsync: async (action: string, options: any) => {
      intents.push({ action, ...options });
      if (over.installerError) throw new Error('installer unavailable');
    } },
    'react-native': { Linking: { openURL: async (url: string) => { urls.push(url); } } },
    zustand: { create: (init: any) => {
      state = init((patch: any) => Object.assign(state, patch), () => state);
      return { getState: () => state };
    } },
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/appInstall.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => modules[name], AbortController, Error });
  return { state: exports.useAppInstall.getState(), update, intents, urls, downloads: () => downloads, deleted: () => deleted };
}

test('a complete download opens the installer with a readable content URI and reuses the file', async () => {
  const h = harness();
  await h.state.install(h.update);
  assert.equal(h.state.phase, 'ready');
  assert.equal(h.state.progress, 1);
  assert.deepEqual(h.intents[0], { action: 'android.intent.action.VIEW', data: 'content://winglet/updates/winglet-0.3.0.apk',
    type: 'application/vnd.android.package-archive', flags: 1 });
  await h.state.install(h.update);
  assert.equal(h.downloads(), 1);
  assert.equal(h.intents.length, 2);
});

test('a size mismatch deletes the incomplete APK and never opens the installer', async () => {
  const h = harness({ size: 99 });
  await h.state.install(h.update);
  assert.equal(h.state.phase, 'error');
  assert.equal(h.state.error, 'The download was incomplete. Try again.');
  assert.equal(h.deleted(), 1);
  assert.equal(h.intents.length, 0);
});

test('cancelling a pending download suppresses installation and releases the download guard', async () => {
  const h = harness({ download: (_url: string, _file: any, options: any) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('cancelled')));
  }) });
  const pending = h.state.install(h.update);
  await h.state.install(h.update);
  assert.equal(h.downloads(), 1);
  h.state.cancel();
  await pending;
  assert.equal(h.state.phase, 'idle');
  assert.equal(h.intents.length, 0);
  const retry = h.state.install(h.update);
  assert.equal(h.downloads(), 2);
  h.state.cancel();
  await retry;
});

test('Cancel wins even when the native download completes instead of rejecting', async () => {
  const h = harness({ download: async (_url: string, file: any, _options: any, state: any) => {
    file.exists = true;
    file.size = 100;
    state.cancel();
    return file;
  } });
  await h.state.install(h.update);
  assert.equal(h.intents.length, 0);
  assert.equal(h.state.phase, 'idle');
});

test('an installer failure becomes a recoverable error', async () => {
  const h = harness({ installerError: true });
  await h.state.install(h.update);
  assert.equal(h.state.phase, 'error');
  assert.equal(h.state.error, "Android's installer didn't open.");
});

test('an unsupported CPU can open the release page without attempting a download', async () => {
  const h = harness();
  await h.state.install({ ...h.update, apk: undefined });
  assert.deepEqual(h.urls, [h.update.page]);
  assert.equal(h.downloads(), 0);
  assert.equal(h.intents.length, 0);
});
