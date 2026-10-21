import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const any: any = new Proxy(function () {}, { get: (_t, key) => key === 'then' ? undefined : key === Symbol.toPrimitive ? () => 0 : any, apply: () => any });

function harness() {
  let cursor = 0;
  const states: any[] = [];
  const jsx = (type: any, props: any) => ({ type, props });
  const modules: Record<string, any> = {
    react: {
      useState: (value: any) => { const i = cursor++; if (!(i in states)) states[i] = value; return [states[i], (next: any) => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
      useEffect: () => undefined, useCallback: (fn: any) => fn,
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Keyboard: { dismiss: () => undefined }, Text: 'Text' },
    '../lib/store': { isOwner: () => true, useApp: (select: any) => select({ runtime: { s: { status: 'online', info: { features: { agent: true, pickers: true } }, messages: {} } } }) },
    '../lib/themeContext': { makeStyles: () => () => any, useTheme: () => any },
    './ui': { Tap: 'Tap' },
  };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/ModelSheet.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, { exports, require: (id: string) => modules[id] ?? any });
  const render = (chatId: string, prepareChat?: () => Promise<string | null>) => {
    cursor = 0;
    const tree = exports.ModelButton({ server: { id: 's' }, chatId, prepareChat });
    return { button: tree.props.children[0], sheet: tree.props.children[1] || null };
  };
  return { render };
}

test('changing chat while a model sheet is open does not open or query settings in the new chat', () => {
  const h = harness();
  h.render('a').button.props.onPress();
  assert.equal(h.render('a').sheet.props.visible, true);
  assert.equal(h.render('b').sheet, null);
});

test('a late dismissal from the previous chat cannot close the new chat model sheet', () => {
  const h = harness();
  h.render('a').button.props.onPress();
  const old = h.render('a').sheet;
  h.render('b').button.props.onPress();
  old.props.onClose(); old.props.onDismiss();
  const current = h.render('b').sheet;
  assert.equal(current.props.chatId, 'b');
  assert.equal(current.props.visible, true);
});

test('a new-chat model sheet opens for the resolved chat instead of the local draft or main chat', async () => {
  const h = harness();
  await h.render('local:new-chat', async () => 'fresh').button.props.onPress();
  assert.equal(h.render('local:new-chat').sheet, null);
  const actual = h.render('fresh').sheet;
  assert.equal(actual.props.chatId, 'fresh');
  assert.equal(actual.props.visible, true);
});

test('failed new-chat preparation leaves the model sheet closed', async () => {
  const h = harness();
  await h.render('local:new-chat', async () => null).button.props.onPress();
  assert.equal(h.render('local:new-chat').sheet, null);
  assert.equal(h.render('general').sheet, null);
});
