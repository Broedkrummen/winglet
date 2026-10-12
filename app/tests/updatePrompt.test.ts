import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

test('locking immediately unmounts the update modal instead of animating it over the lock screen', async () => {
  let locked = false;
  let cursor = 0;
  let mounted = false;
  const states: any[] = [];
  const jsx = (type: any, props: any) => ({ type, props });
  const exports: any = {};
  const modules: Record<string, any> = {
    'expo-constants': { expoConfig: { version: '0.2.0' } },
    react: { useState: (initial: any) => {
      const index = cursor++;
      if (!mounted) states[index] = initial;
      return [states[index], (value: any) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    }, useEffect: (fn: () => void) => { if (!mounted) fn(); } },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Text: 'Text', View: 'View' },
    '../lib/appInstall': { useAppInstall: (select: any) => select({ phase: 'idle' }) },
    '../lib/appUpdateCheck': { appUpdateSupported: true, useAppUpdate: (select: any) => select({ update: { version: '0.3.0' } }) },
    '../lib/appLock': { useLock: (select: any) => select({ locked }) },
    '../lib/prefs': { usePrefs: (select: any) => select({ prefs: { updateCheck: true } }) },
    '../lib/storage': { getJSON: async () => null },
    '../lib/themeContext': { makeStyles: () => () => ({}), useTheme: () => ({}) },
    './icons': {}, './Sheet': { Sheet: 'Sheet' }, './ui': { Button: 'Button' },
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/AppUpdate.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: (name: string) => modules[name] });
  const render = () => { cursor = 0; const result = exports.UpdatePrompt(); mounted = true; return result; };
  render();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(render().type, 'Sheet');
  locked = true;
  assert.equal(render(), null);
  locked = false;
  assert.equal(render().type, 'Sheet');
});
