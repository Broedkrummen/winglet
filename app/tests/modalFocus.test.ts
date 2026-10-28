import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

test('web drawer confines Tab, skips disabled controls and restores the opener after Escape', () => {
  let cleanup: (() => void) | undefined;
  let key: (event: any) => void;
  let closed = false;
  const doc: any = { activeElement: undefined,
    addEventListener: (_name: string, fn: any) => { key = fn; }, removeEventListener() {} };
  const control = (disabled = false): any => ({ tabIndex: 0, isConnected: true, matches: () => disabled,
    getClientRects: () => [1], focus() { doc.activeElement = this; } });
  const opener = control(), first = control(), disabled = control(true), last = control();
  doc.activeElement = opener;
  const result: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/useModalFocus.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: result, document: doc, requestAnimationFrame: (fn: any) => { fn(); return 1; }, cancelAnimationFrame() {},
    require: (name: string) => name === 'react' ? { useEffect: (fn: any) => { cleanup = fn(); } } : { Platform: { OS: 'web' } } });
  result.useModalFocus(true, { current: { querySelectorAll: () => [first, disabled, last] } }, () => { closed = true; });
  assert.equal(doc.activeElement, first);
  const event = (value: string, shiftKey = false) => ({ key: value, shiftKey, preventDefault() {}, stopPropagation() {} });
  key!(event('Tab', true)); assert.equal(doc.activeElement, last);
  key!(event('Tab')); assert.equal(doc.activeElement, first);
  key!(event('Escape')); assert.equal(closed, true);
  cleanup!(); assert.equal(doc.activeElement, opener);
});
