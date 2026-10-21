import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { keyboardInset } from '../src/lib/keyboard.ts';

function harness() {
  let cursor = 0;
  let mounted = false;
  let viewHeight = 934;
  const states: any[] = [];
  const effects: (() => any)[] = [];
  const events: Record<string, (event?: any) => void> = {};
  const jsx = (type: any, props: any) => ({ type, props });
  const modules: Record<string, any> = {
    react: {
      useRef: (value: any) => { const i = cursor++; return states[i] ??= { current: value }; },
      useState: (value: any) => { const i = cursor++; if (!(i in states)) states[i] = value; return [states[i], (next: any) => { states[i] = next; }]; },
      useEffect: (fn: any) => { if (!mounted) effects.push(fn); }, useCallback: (fn: any) => fn,
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Platform: { OS: 'android' }, View: 'View', useWindowDimensions: () => ({ width: 420, height: 934 }),
      Keyboard: { metrics: () => undefined, addListener: (name: string, fn: any) => { events[name] = fn; return { remove: () => { delete events[name]; } }; } } },
    '../lib/keyboard': { keyboardInset },
  };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/KeyboardViewport.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, { exports, require: (id: string) => modules[id], setTimeout: () => 1, clearTimeout: () => undefined });
  const render = () => {
    cursor = 0;
    const tree = exports.KeyboardViewport({ children: (visible: boolean) => visible });
    tree.props.ref.current = { measureInWindow: (fn: any) => fn(0, 0, 420, viewHeight) };
    return tree;
  };
  render(); effects.forEach((fn) => fn()); mounted = true;
  return { render, events, resize: (height: number) => { viewHeight = height; render().props.onLayout(); } };
}

test('the actual composer viewport moves above the keyboard, then returns when it closes', () => {
  const h = harness();
  h.events.keyboardDidShow({ endCoordinates: { screenY: 596, height: 338 } });
  let inner = h.render().props.children;
  assert.equal(inner.props.style.marginBottom, 338);
  assert.equal(inner.props.children, true);
  h.events.keyboardDidHide();
  inner = h.render().props.children;
  assert.equal(inner.props.style.marginBottom, 0);
  assert.equal(inner.props.children, false);
});

test('a native resize after keyboard opening removes a provisional inset instead of lifting twice', () => {
  const h = harness();
  h.events.keyboardDidShow({ endCoordinates: { screenY: 596, height: 338 } });
  h.resize(596);
  assert.equal(h.render().props.children.props.style.marginBottom, 0);
  h.resize(934);
  assert.equal(h.render().props.children.props.style.marginBottom, 338);
});
