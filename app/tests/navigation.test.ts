import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { chatKey } from '../src/lib/chatOrganization.ts';

const exports: any = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/navigation.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, require: () => ({ chatKey }) });
const { navigationWidth, sidebarChats, sidebarDrawerWidth } = exports;

test('mobile drawer occupies 72 percent and leaves an outside tap target, with a desktop width cap', () => {
  assert.equal(sidebarDrawerWidth(390), 390 * 0.72);
  assert.equal(sidebarDrawerWidth(320), 320 * 0.72);
  assert.equal(sidebarDrawerWidth(1400), 340);
});

test('sidebar modes preserve usable conversation width on phones and wide screens', () => {
  assert.equal(navigationWidth(390, 'auto'), 0);
  assert.equal(navigationWidth(390, 'drawer'), 0);
  assert.equal(navigationWidth(390, 'pinned'), 64);
  assert.equal(navigationWidth(1200, 'auto'), 280);
  assert.equal(navigationWidth(1200, 'pinned'), 280);
  assert.equal(navigationWidth(1200, 'drawer'), 0);
  assert.equal(navigationWidth(900), 0);
});

const servers: any[] = [{ id: 'a', bot: { title: 'Atlas' } }, { id: 'b', bot: { title: 'Nova' } }];
const chat = (id: string, title: string, updated_at: number, kind = 'chat'): any => ({ id, title, updated_at, kind });
const chats = { a: { main: chat('main', 'Main', 20), same: chat('same', 'Trip', 30), updates: chat('updates', 'Updates', 90, 'home') },
  b: { same: chat('same', 'Work', 40), old: chat('old', 'Notes', 1) } };

test('history pins first, excludes archives/updates and keeps identical chat IDs isolated by bot', () => {
  const rows = sidebarChats(servers, chats, [chatKey('b', 'old')], [chatKey('a', 'same')]);
  assert.deepEqual(rows.map((x) => [x.server.id, x.chat.id]), [['b', 'old'], ['b', 'same'], ['a', 'main']]);
  assert.equal(rows[0].pinned, true);
});

test('sidebar search matches chat titles and bot names without leaking archives', () => {
  assert.deepEqual(sidebarChats(servers, chats, [], [], '  nOvA ').map((x) => x.chat.id), ['same', 'old']);
  assert.equal(sidebarChats(servers, chats, [], [chatKey('a', 'same')], 'Trip').length, 0);
  assert.equal(sidebarChats([], {}, [], []).length, 0);
});

test('sidebar search finds unsent text and attachments only in their own bot and chat', () => {
  const previews = { [chatKey('a', 'same')]: 'Draft · Packing list', [chatKey('b', 'same')]: 'Draft · budget.pdf' };
  assert.deepEqual(sidebarChats(servers, chats, [], [], 'packing', previews).map((x) => x.server.id), ['a']);
  assert.deepEqual(sidebarChats(servers, chats, [], [], 'budget.pdf', previews).map((x) => x.server.id), ['b']);
  assert.equal(sidebarChats(servers, chats, [], [chatKey('a', 'same')], 'packing', previews).length, 0);
});

test('locking immediately removes the drawer and pinned history, even through a stale open callback', () => {
  let locked = false;
  let changes = 0;
  const jsx = (type: any, props: any) => ({ type, props });
  const modules: Record<string, any> = {
    react: { createContext: () => ({ Provider: 'Provider' }), memo: (component: any) => component, useCallback: (fn: any) => fn, useMemo: (fn: any) => fn(),
      useEffect: () => {}, useState: () => [true, () => changes++] },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { View: 'View', Platform: { OS: 'android' }, useWindowDimensions: () => ({ width: 1200 }), Keyboard: { dismiss: () => {} } },
    'expo-router': { usePathname: () => '/' },
    '../lib/prefs': { usePrefs: (select: any) => select({ prefs: { sidebar: 'auto' } }) },
    '../lib/appLock': { useLock: Object.assign((select: any) => select({ locked }), { getState: () => ({ locked }) }) },
    '../lib/store': { useApp: (select: any) => select({ servers: [{}] }) },
    '../lib/navigation': { navigationWidth },
    '../lib/themeContext': { makeStyles: () => () => ({}), useTheme: () => ({ colors: { bg: '#000' } }) },
  };
  const result: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/AppNavigation.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports: result, require: (name: string) => modules[name] ?? {} });
  const unlocked = result.AppNavigation({ children: 'chat' });
  assert.equal(unlocked.props.value.reserved, 280);
  assert.ok(unlocked.props.children.props.children[0]);
  assert.ok(unlocked.props.children.props.children[2]);
  locked = true;
  unlocked.props.value.open();
  unlocked.props.value.home();
  assert.equal(changes, 0);
  const cover = result.AppNavigation({ children: 'chat' });
  assert.equal(cover.props.value.reserved, 0);
  const [rail, content, drawer] = cover.props.children.props.children;
  assert.equal(rail, null);
  assert.equal(drawer, null);
  assert.equal(content.props['aria-hidden'], true);
  assert.equal(content.props.pointerEvents, 'none');
});

test('drawer dismissal never waits for an animation callback and Android Back is handled only while open', () => {
  const jsx = (type: any, props: any) => ({ type, props });
  let back: (() => boolean) | undefined;
  let removed = false;
  let closes = 0;
  const cleanups: any[] = [];
  const animation = { enabled: () => animation, activeOffsetX: () => animation, failOffsetY: () => animation,
    onUpdate: () => animation, onEnd: () => animation, onFinalize: () => animation };
  const modules: Record<string, any> = {
    react: { createContext: () => ({}), memo: (component: any) => component, useEffect: (fn: any) => { cleanups.push(fn()); } },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { View: 'View', Platform: { OS: 'android' }, StyleSheet: { absoluteFill: {} }, useWindowDimensions: () => ({ width: 390 }),
      BackHandler: { addEventListener: (_name: string, fn: any) => { back = fn; return { remove: () => { removed = true; } }; } } },
    'react-native-gesture-handler': { Gesture: { Pan: () => animation }, GestureHandlerRootView: 'GestureHandlerRootView' },
    'react-native-reanimated': { __esModule: true, default: { View: 'AnimatedView' }, useSharedValue: (value: number) => ({ value }),
      useAnimatedStyle: (fn: any) => fn(), withTiming: (value: number) => value, withSpring: (value: number) => value },
    '../lib/motion': { useReducedMotion: () => false, spring: { snappy: {} } },
    '../lib/navigation': { sidebarDrawerWidth },
    '../lib/themeContext': { makeStyles: () => () => ({}), useTheme: () => ({ colors: { overlay: '#000' } }) },
  };
  const result: any = {};
  const source = readFileSync(new URL('../src/components/AppNavigation.tsx', import.meta.url), 'utf8') + '\nexport { SidebarDrawer };';
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports: result, require: (name: string) => modules[name] ?? {} });
  const opened = result.SidebarDrawer({ visible: true, onClose: () => closes++ });
  assert.equal(opened.type, 'View', 'drawer shares the app window instead of leaving an orphan native modal');
  assert.equal(back!(), true);
  assert.equal(closes, 1);
  cleanups.forEach((fn) => fn?.());
  assert.equal(removed, true);
  assert.equal(result.SidebarDrawer({ visible: false, onClose: () => closes++ }), null);
});
