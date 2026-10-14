import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const any: any = new Proxy(function () {}, {
  get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : key === 'then' ? undefined : any),
  apply: () => any,
});

/** The Usage screen's chart, rendered with React's hooks faked so it can be driven like the same mounted component. */
function loadBars() {
  let cursor = 0;
  let mounted = false;
  const states: any[] = [];
  const jsx = (type: any, props: any) => ({ type, props });
  const exports: any = {};
  const modules: Record<string, any> = {
    react: {
      useState: (initial: any) => {
        const index = cursor++;
        if (!mounted) states[index] = initial;
        return [states[index], (value: any) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
      },
      useEffect: () => undefined,
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { Pressable: 'Pressable', Text: 'Text', View: 'View' },
    '../components/ui': { Card: 'Card' },
    '../lib/themeContext': { makeStyles: () => () => any, useTheme: () => any },
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/app/usage.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, { exports, require: (m: string) => modules[m] ?? any });
  return (rows: any[]) => { cursor = 0; const out = exports.DailyBars({ rows }); mounted = true; return out; };
}

const days = (n: number) => Array.from({ length: n }, (_, i) => ({
  day: new Date(Date.UTC(2026, 9, 14 - (n - 1 - i))).toISOString().slice(0, 10), input_tokens: 1000 * (i + 1), output_tokens: 0,
}));
const text = (node: any): string => (node == null || typeof node !== 'object' ? String(node ?? '')
  : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children));
const bars = (out: any) => out.props.children[1].props.children[1].props.children;
const readout = (out: any) => text(out.props.children[0]);

test('a day picked in a longer period does not crash a shorter one, and an in-range pick keeps its day', () => {
  const render = loadBars();
  const week = days(7);
  const month = days(30);
  render(week); // 7 days, cached
  let out = render(month);
  bars(out)[20].props.onPress(); // a late bar in the 30 days, not in the 7
  assert.match(readout(render(month)), /21\.0k tokens/);
  // Back to the cached 7 days: the picked day isn't there, so it shows the latest instead of throwing.
  out = render(week);
  assert.match(readout(out), /\(latest\)/);
  assert.match(readout(out), /7\.0k tokens/);
  // A day in both periods stays that day, not that position: two days ago is bar 27 of 30 and bar 4 of 7.
  bars(render(month))[27].props.onPress();
  out = render(week);
  assert.doesNotMatch(readout(out), /latest/);
  assert.match(readout(out), /5\.0k tokens/);
});
