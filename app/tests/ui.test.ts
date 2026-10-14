import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

// Anything a component reaches for that these tests don't care about: callable, chainable, indexable.
const any: any = new Proxy(function () {}, {
  get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : key === 'then' ? undefined : any),
  apply: () => any,
});

/** ui.tsx with React's hooks faked, so a component's function can be called and its output inspected. */
function loadUi() {
  let cursor = 0;
  let mounted = false;
  const states: any[] = [];
  const timers: (() => void)[] = [];
  const haptics: string[] = [];
  const jsx = (type: any, props: any) => ({ type, props });
  const exports: any = {};
  const modules: Record<string, any> = {
    react: {
      useState: (initial: any) => {
        const index = cursor++;
        if (!mounted) states[index] = initial;
        return [states[index], (value: any) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
      },
      useRef: (value: any) => {
        const index = cursor++;
        if (!mounted) states[index] = { current: value };
        return states[index];
      },
      useEffect: () => undefined,
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { Pressable: 'Pressable', Text: 'Text', TextInput: 'TextInput', View: 'View', Platform: { OS: 'android' } },
    '../lib/haptics': { haptic: { light: () => haptics.push('light'), selection: () => haptics.push('selection') } },
    '../lib/themeContext': { makeStyles: () => () => any, useTheme: () => any },
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/ui.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, {
    exports, require: (m: string) => modules[m] ?? any,
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout: () => undefined,
  });
  const render = (name: string, props: any) => { cursor = 0; const out = exports[name](props); mounted = true; return out; };
  return { render, timers, haptics };
}

test('a destructive button asks for a second tap, and forgets after a few seconds', () => {
  const ui = loadUi();
  let done = 0;
  const props = { title: 'Remove key', onConfirm: () => { done += 1; } };
  let out = ui.render('ConfirmButton', props);
  assert.equal(out.props.title, 'Remove key');
  assert.equal(out.props.variant, 'ghost');
  out.props.onPress();
  out = ui.render('ConfirmButton', props);
  assert.equal(out.props.title, 'Tap again to remove key');
  assert.equal(out.props.variant, 'danger');
  assert.deepEqual(ui.haptics, ['light']);
  assert.equal(done, 0);
  // Left alone, it disarms.
  ui.timers.at(-1)!();
  out = ui.render('ConfirmButton', props);
  assert.equal(out.props.variant, 'ghost');
  // Two taps do it.
  out.props.onPress();
  ui.render('ConfirmButton', props).props.onPress();
  assert.equal(done, 1);
  assert.equal(ui.render('ConfirmButton', props).props.title, 'Remove key');
});

test('the search box shows a clear button once something is typed', () => {
  const ui = loadUi();
  let value = '';
  const props = () => ({ value, onChangeText: (v: string) => { value = v; }, placeholder: 'Search the log' });
  const kids = (out: any) => out.props.children.filter(Boolean);
  assert.equal(kids(ui.render('SearchField', props())).length, 2); // icon and input
  value = 'error';
  const clear = kids(ui.render('SearchField', props()))[2];
  assert.equal(clear.props.accessibilityLabel, 'Clear search');
  clear.props.onPress();
  assert.equal(value, '');
});
