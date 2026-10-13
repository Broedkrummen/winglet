import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

test('locking immediately unmounts the verify sheet instead of leaving it above the lock screen', () => {
  let locked = false;
  let cursor = 0;
  let mounted = false;
  const states: any[] = [];
  const server = { id: 's1', bot: { title: 'Hermes' } };
  const jsx = (type: any, props: any) => ({ type, props });
  const exports: any = {};
  const modules: Record<string, any> = {
    'expo-router': { router: { push: () => undefined } },
    react: { useState: (initial: any) => {
      const index = cursor++;
      if (!mounted) states[index] = initial;
      return [states[index], (value: any) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    }, useEffect: () => undefined },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { Platform: { OS: 'android' }, Text: 'Text', View: 'View' },
    '../lib/api': { hasSigningKey: async () => true },
    '../lib/appLock': { useLock: (select: any) => select({ locked }) },
    '../lib/store': { useApp: (select: any) => select({ servers: [server], runtime: {} }) },
    '../lib/themeContext': { makeStyles: () => () => ({}), useTheme: () => ({ colors: {} }) },
    '../lib/verify': { useVerify: (select: any) => select({ serverId: 's1', close: () => undefined }) },
    './icons': { KeyRound: 'KeyRound', QrCode: 'QrCode' }, './Sheet': { Sheet: 'Sheet' }, './ui': { Button: 'Button', Card: 'Card' },
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/VerifyPhone.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: (name: string) => modules[name] });
  const render = () => { cursor = 0; const result = exports.VerifySheet(); mounted = true; return result; };
  const open = render();
  assert.equal(open.type, 'Sheet');
  assert.equal(open.props.visible, true);
  locked = true;
  assert.equal(render(), null);
  // Still asked for after unlocking: the sheet comes back as it was.
  locked = false;
  assert.equal(render().type, 'Sheet');
});
