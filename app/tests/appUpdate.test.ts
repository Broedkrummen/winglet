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
const { newestUpdate, pickApk, releaseNotes, checkIsFresh, CHECK_EVERY_MS } = load('appUpdate.ts', () => version);

test('this fork checks its own releases and installs beside upstream', () => {
  assert.equal(load('appUpdate.ts', () => version).RELEASES_URL,
    'https://api.github.com/repos/Broedkrummen/winglet/releases?per_page=10');
  const config = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')).expo;
  assert.equal(config.android.package, 'io.github.broedkrummen.winglet');
  assert.equal(config.ios.bundleIdentifier, config.android.package);
  const module: any = { exports: {} };
  vm.runInNewContext(readFileSync(new URL('../app.config.js', import.meta.url), 'utf8'), { module, process: { env: { WINGLET_DEV: '1' } } });
  assert.equal(module.exports({ config }).android.package, 'io.github.broedkrummen.winglet.dev');
});

const apk = (name: string) => ({ name, browser_download_url: `https://dl/${name}`, size: name.length });
const rel = (tag: string, over: any = {}) => ({
  tag_name: tag, html_url: `https://gh/${tag}`, prerelease: tag.includes('-'), body: `Winglet ${tag}.`,
  assets: [apk(`winglet-${tag.slice(1)}.apk`), apk(`winglet-plugin-${tag.slice(1)}.zip`)], ...over,
});

test('offers the newest full release above this one', () => {
  const releases = [rel('v0.2.1'), rel('v0.3.0-beta.1'), rel('v0.2.0'), rel('v0.1.2')];
  assert.deepEqual({ ...newestUpdate(releases, '0.2.0') },
    { version: '0.2.1', page: 'https://gh/v0.2.1', apk: 'https://dl/winglet-0.2.1.apk', apkSize: 17, notes: 'Winglet v0.2.1.' });
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
  const found = newestUpdate([debug], '0.2.0');
  assert.equal(found.version, '0.2.1');
  assert.equal(found.apk, undefined);
});

test('per-CPU releases hand out the build for this phone', () => {
  const split = [apk('winglet-0.3.0-armeabi-v7a.apk'), apk('winglet-0.3.0-arm64-v8a.apk'), apk('winglet-plugin-0.3.0.zip')];
  const name = (abis?: string[] | null) => pickApk(split, abis)?.name;
  assert.equal(name(['arm64-v8a', 'armeabi-v7a', 'armeabi']), 'winglet-0.3.0-arm64-v8a.apk');
  assert.equal(name(['armeabi-v7a', 'armeabi']), 'winglet-0.3.0-armeabi-v7a.apk');
  // Unknown CPUs: the 64-bit ARM build, which fits nearly every phone.
  assert.equal(name(null), 'winglet-0.3.0-arm64-v8a.apk');
  assert.equal(name([]), 'winglet-0.3.0-arm64-v8a.apk');
  // An x86 emulator gets nothing it can't install.
  assert.equal(name(['x86_64']), undefined);
  // Older releases had one universal APK, which fits every phone.
  assert.equal(pickApk([apk('winglet-0.2.0.apk')], ['x86_64'])?.name, 'winglet-0.2.0.apk');
  assert.equal(pickApk([apk('winglet-0.2.0.apk')], ['armeabi-v7a'])?.name, 'winglet-0.2.0.apk');
  assert.equal(newestUpdate([rel('v0.3.0', { assets: split })], '0.2.0', ['armeabi-v7a'])?.apk, 'https://dl/winglet-0.3.0-armeabi-v7a.apk');
});

test("a release's summary is its first paragraph, on one line", () => {
  assert.equal(releaseNotes('Winglet 0.3: pets,\nand smaller APKs.\n\n**Install:** download it.\n\n## What\'s new'), 'Winglet 0.3: pets, and smaller APKs.');
  assert.equal(releaseNotes('## What\'s new\n- Pets'), undefined);
  assert.equal(releaseNotes(''), undefined);
  assert.equal(releaseNotes(null), undefined);
  const long = releaseNotes('word '.repeat(200));
  assert.ok(long.length <= 401 && long.endsWith('word…'));
});

test('a stored check is reused only by the same app version, for half a day', () => {
  const now = 1_000_000_000_000;
  assert.equal(checkIsFresh({ checkedAt: now - 1000, current: '0.2.0' }, '0.2.0', now), true);
  assert.equal(checkIsFresh({ checkedAt: now - CHECK_EVERY_MS, current: '0.2.0' }, '0.2.0', now), false);
  assert.equal(checkIsFresh({ checkedAt: now - 1000, current: '0.1.2' }, '0.2.0', now), false);
  assert.equal(checkIsFresh({ checkedAt: now + 60_000, current: '0.2.0' }, '0.2.0', now), false);
  assert.equal(checkIsFresh(null, '0.2.0', now), false);
});
