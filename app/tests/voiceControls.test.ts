import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const any: any = new Proxy(function () {}, { get: (_t, key) => key === 'then' ? undefined : key === Symbol.toPrimitive ? () => 0 : any, apply: () => any });

function load(file: string, names: string[]) {
  const finishes: boolean[] = [];
  const callbacks: Record<string, (...args: any[]) => void> = {};
  let recorderCalls = 0;
  const chain: any = new Proxy({}, { get: (_t, key: string) => (...args: any[]) => { if (key.startsWith('on')) callbacks[key] = args[0]; return chain; } });
  const jsx = (type: any, props: any) => ({ type, props });
  const modules: Record<string, any> = {
    react: { useState: (value: any) => [value, () => undefined], useRef: (value: any) => ({ current: value }), useEffect: () => undefined, useCallback: (fn: any) => fn },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Platform: { OS: 'web' }, View: 'View', Text: 'Text' },
    'react-native-gesture-handler': { Gesture: { Pan: () => chain }, GestureDetector: 'GestureDetector' },
    '../lib/voiceNote': { useVoiceNote: () => { recorderCalls++; return { recording: false, start: async () => undefined, finish: async (cancel: boolean) => { finishes.push(cancel); } }; } },
    '../lib/themeContext': { makeStyles: () => () => any, useTheme: () => any },
    '../lib/motion': { useReducedMotion: () => true },
    '../lib/mainBot': { useMainBot: () => ({ id: 'bot', bot: { title: 'Bot' } }) },
    '../lib/pets': { petTones: () => undefined },
    '../lib/store': { draftKey: (bot: string, chat: string) => `${bot}:${chat}`,
      useApp: (select: any) => select({ drafts: {}, draftFiles: {}, replyTo: {}, runtime: { bot: { status: 'online' } } }) },
    '../lib/prefs': { usePrefs: (select: any) => select({ prefs: { busyMode: 'steer' } }) },
    '../lib/attach': { canSend: () => false },
  };
  const exports: any = {};
  const source = readFileSync(new URL(`../src/components/${file}`, import.meta.url), 'utf8') + `\nexport { ${names.join(', ')} };`;
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText,
    { exports, require: (id: string) => modules[id] ?? any });
  return { exports, callbacks, finishes, recorderCalls: () => recorderCalls };
}

test('an interrupted microphone gesture cancels instead of delivering the recording', () => {
  const h = load('Composer.tsx', ['VoiceButton']);
  h.exports.VoiceButton({ server: { id: 'bot' }, chatId: 'chat' });
  h.callbacks.onFinalize({ translationX: 0 }, false);
  h.callbacks.onFinalize({ translationX: 0 }, true);
  h.callbacks.onFinalize({ translationX: -100 }, true);
  assert.deepEqual(h.finishes, [true, false, true]);
});

test('keyboard voice recording sends on release and cancels when focus leaves', () => {
  const h = load('Composer.tsx', ['VoiceButton']);
  const tree = h.exports.VoiceButton({ server: { id: 'bot' }, chatId: 'chat' });
  const button = tree.props.children[1].props.children;
  assert.equal(button.props.tabIndex, 0);
  button.props.onKeyDown({ key: ' ', preventDefault() {}, repeat: false });
  button.props.onKeyUp({ key: ' ', preventDefault() {} });
  button.props.onBlur();
  assert.deepEqual(h.finishes, [false, true]);
});

test('a running task keeps Stop in the task strip without exposing an unscoped voice send', () => {
  const h = load('Composer.tsx', ['VoiceButton']);
  const props = { server: { id: 'bot' }, chatId: 'chat', bottomInset: 0, target: { current: null }, onHeight: () => {}, placeholder: 'Message' };
  const nodes = (node: any): any[] => !node || typeof node !== 'object' ? []
    : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
  const idle = nodes(h.exports.Composer({ ...props, busy: false }));
  assert.equal(idle.filter((node) => node.type === h.exports.VoiceButton).length, 1);
  const working = nodes(h.exports.Composer({ ...props, busy: true }));
  assert.equal(working.filter((node) => node.type === h.exports.VoiceButton).length, 0);
  const send = working.find((node) => node.props?.accessibilityLabel === 'Send');
  assert.equal(send?.props.disabled, true);
});
