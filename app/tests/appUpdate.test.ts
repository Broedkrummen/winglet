import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const load = (file: string, require: (m: string) => unknown = () => ({})) => {
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/lib/${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require });
  return exports;
};
const version = load('version.ts');
const { newestUpdate, checkIsFresh, CHECK_EVERY_MS } = load('appUpdate.ts', () => version);

const apk = (name: string) => ({ name, browser_download_url: `https://dl/${name}` });
const rel = (tag: string, over: any = {}) => ({
  tag_name: tag, html_url: `https://gh/${tag}`, prerelease: tag.includes('-'),
  assets: [apk(`winglet-${tag.slice(1)}.apk`), apk(`winglet-plugin-${tag.slice(1)}.zip`)], ...over,
});

test('offers the newest full release above this one', () => {
  const releases = [rel('v0.2.1'), rel('v0.3.0-beta.1'), rel('v0.2.0'), rel('v0.1.2')];
  assert.deepEqual({ ...newestUpdate(releases, '0.2.0') }, { version: '0.2.1', page: 'https://gh/v0.2.1', apk: 'https://dl/winglet-0.2.1.apk' });
  assert.equal(newestUpdate(releases, '0.2.1'), null);
  assert.equal(newestUpdate(releases, '0.3.0'), null);
});

test('betas are offered only to people already on a beta', () => {
  const releases = [rel('v0.3.0-beta.2'), rel('v0.2.1'), rel('v0.3.0-beta.1')];
  assert.equal(newestUpdate(releases, '0.2.1'), null);
  assert.equal(newestUpdate(releases, '0.3.0-beta.1')?.version, '0.3.0-beta.2');
  // A beta tester is moved on to the final release once it's out.
  assert.equal(newestUpdate([rel('v0.3.0'), ...releases], '0.3.0-beta.2')?.version, '0.3.0');
});

test('drafts, odd tags and debug-key builds are ignored', () => {
  assert.equal(newestUpdate([rel('v9.0.0', { draft: true }), rel('nightly'), rel('v1.2')], '0.2.0'), null);
  const debug = rel('v0.2.1', { assets: [apk('winglet-dev-abc1234-debugkey.apk')] });
  assert.deepEqual({ ...newestUpdate([debug], '0.2.0') }, { version: '0.2.1', page: 'https://gh/v0.2.1', apk: undefined });
});

test('per-CPU releases hand out the 64-bit ARM build', () => {
  const split = rel('v0.2.1', { assets: [apk('winglet-0.2.1-armeabi-v7a.apk'), apk('winglet-0.2.1-arm64-v8a.apk')] });
  assert.equal(newestUpdate([split], '0.2.0')?.apk, 'https://dl/winglet-0.2.1-arm64-v8a.apk');
});

test('a stored check is reused only by the same app version, for half a day', () => {
  const now = 1_000_000_000_000;
  assert.equal(checkIsFresh({ checkedAt: now - 1000, current: '0.2.0' }, '0.2.0', now), true);
  assert.equal(checkIsFresh({ checkedAt: now - CHECK_EVERY_MS, current: '0.2.0' }, '0.2.0', now), false);
  assert.equal(checkIsFresh({ checkedAt: now - 1000, current: '0.1.2' }, '0.2.0', now), false);
  assert.equal(checkIsFresh({ checkedAt: now + 60_000, current: '0.2.0' }, '0.2.0', now), false);
  assert.equal(checkIsFresh(null, '0.2.0', now), false);
});
