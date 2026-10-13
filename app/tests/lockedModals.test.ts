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

const find = (node: any, type: string): any => {
  if (!node || typeof node !== 'object') return undefined;
  if (node.type === type) return node;
  const kids = node.props?.children;
  for (const kid of Array.isArray(kids) ? kids : [kids]) {
    const hit = find(kid, type);
    if (hit) return hit;
  }
  return undefined;
};

test('full-screen photos are hidden while locked and come back on the photo it was on, unzoomed', () => {
  const lock = { locked: false };
  const render = load('MediaViewer.tsx', 'MediaViewer', lock);
  const items = ['photo1', 'photo2', 'photo3'].map((name) => ({ uri: `https://x/${name}.jpg`, name }));
  const props = (index: number | null) => ({ items, index, onClose: () => undefined });
  const shown = (out: any) => {
    const list = find(out, 'FlatList');
    return { start: list.props.initialScrollIndex, paging: list.props.scrollEnabled, list };
  };
  assert.equal(render(props(null)), null);
  // Opened on the second photo: the list starts there on its first render.
  assert.equal(shown(render(props(1))).start, 1);
  // Swiped to the third, then zoomed in.
  let out = shown(render(props(1)));
  out.list.props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 800 } } });
  out.list.props.renderItem({ item: items[2] }).props.onZoom(true);
  assert.equal(shown(render(props(1))).paging, false);
  lock.locked = true;
  assert.equal(render(props(1)), null);
  lock.locked = false;
  out = shown(render(props(1)));
  assert.equal(out.start, 2);
  assert.equal(out.paging, true);
  assert.ok(JSON.stringify(render(props(1))).includes('Share photo3'));
  // Closed and opened again on the first photo: it starts there.
  render(props(null));
  assert.equal(shown(render(props(0))).start, 0);
});
