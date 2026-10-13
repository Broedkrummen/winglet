import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

// Anything a component reaches for that this test doesn't care about: callable, chainable, indexable.
const any: any = new Proxy(function () {}, {
  get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : key === 'then' ? undefined : any),
  apply: () => any,
});

/** Renders a component's function with hooks faked, `locked` read from the app lock. */
function load(file: string, name: string, lock: { locked: boolean }) {
  let cursor = 0;
  let mounted = false;
  const states: any[] = [];
  const jsx = (type: any, props: any) => ({ type, props });
  const exports: any = {};
  const react = {
    useState: (initial: any) => {
      const index = cursor++;
      if (!mounted) states[index] = initial;
      return [states[index], (value: any) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useEffect: () => undefined,
    useRef: (value: any) => ({ current: value }),
  };
  const modules: Record<string, any> = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { ...Object.fromEntries(['Modal', 'Pressable', 'Text', 'View', 'FlatList'].map((n) => [n, n])),
      Platform: { OS: 'android' }, StyleSheet: { absoluteFill: {} }, useWindowDimensions: () => ({ width: 400, height: 800 }) },
    'react-native-reanimated': { __esModule: true, default: { View: 'Animated.View' }, useSharedValue: (v: any) => ({ value: v }),
      useAnimatedStyle: () => ({}), runOnJS: any, withSpring: any, withTiming: any },
    '../lib/appLock': { useLock: (select: any) => select(lock) },
    '../lib/themeContext': { makeStyles: () => () => any, useTheme: () => any },
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/components/${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, { exports, require: (m: string) => modules[m] ?? any });
  return (props: any) => { cursor = 0; const out = exports[name](props); mounted = true; return out; };
}

test('an open sheet is unmounted at once while the app is locked, and comes back after unlocking', () => {
  const lock = { locked: false };
  const render = load('Sheet.tsx', 'Sheet', lock);
  const props = { visible: true, onClose: () => undefined, title: 'Rename', children: 'private' };
  assert.equal(render(props).type, 'Modal');
  lock.locked = true;
  assert.equal(render(props), null);
  lock.locked = false;
  assert.equal(render(props).type, 'Modal');
});

test('full-screen photos are hidden while the app is locked', () => {
  const lock = { locked: false };
  const render = load('MediaViewer.tsx', 'MediaViewer', lock);
  const props = { items: [{ uri: 'https://x/photo.jpg', name: 'photo.jpg' }], index: 0, onClose: () => undefined };
  assert.equal(render(props).type, 'Modal');
  lock.locked = true;
  assert.equal(render(props), null);
  lock.locked = false;
  assert.equal(render(props).type, 'Modal');
});
