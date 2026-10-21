import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { mainFirst } from '../src/lib/bots.ts';
import { DECK_SPRING, releaseDeckPage, resistDeckEdge } from '../src/lib/botDeck.ts';

const fallback: any = new Proxy(function () {}, { get: (_t, key) => key === 'then' ? undefined : fallback, apply: () => fallback });
function harness(count = 3, reduced = false, activePage?: string, focused = false) {
  let cursor = 0;
  let effects: (() => void)[] = [];
  const hooks: any[] = [];
  const selections: any[] = [];
  const shared: any[] = [];
  const pages: string[] = [];
  const actions: string[] = [];
  const pageChanged = (page: string) => pages.push(page);
  const activate = (page: string) => actions.push(page);
  let ticks = 0;
  const servers = Array.from({ length: count }, (_, i) => ({ id: `bot${i}`, bot: { title: `Bot ${i}` } }));
  const prefs = { mainBot: 'bot0' };
  const drafts = { 'bot0:home0': 'first draft', 'bot1:home1': 'second draft' };
  const store = { servers, drafts, selection: { serverId: 'bot0' }, runtime: Object.fromEntries(servers.map((b, i) => [b.id, { home: `home${i}` }])),
    select: (id: string, chat: string) => { selections.push([id, chat]); store.selection.serverId = id; } };
  const jsx = (type: any, props: any) => ({ type, props });
  const gesture: any = { handlers: {}, enabled: (on: boolean) => { gesture.on = on; return gesture; } };
  for (const name of ['activeOffsetX', 'failOffsetY']) gesture[name] = () => gesture;
  for (const name of ['onStart', 'onUpdate', 'onEnd', 'onFinalize']) gesture[name] = (fn: any) => { gesture.handlers[name] = fn; return gesture; };
  const modules: Record<string, any> = {
    react: { memo: (fn: any) => fn, useMemo: (fn: any) => fn(), useCallback: (fn: any) => fn,
      useRef: (value: any) => { const i = cursor++; return hooks[i] ??= { current: value }; },
      useEffect: (fn: any, deps: any[]) => { const i = cursor++; const previous = hooks[i]; hooks[i] = deps;
        if (!previous || deps.some((value, n) => value !== previous[n])) effects.push(fn); },
      useState: (value: any) => { const i = cursor++; if (!(i in hooks)) hooks[i] = value; return [hooks[i], (next: any) => { hooks[i] = next; }]; } },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { View: 'View', Keyboard: { dismiss: () => undefined } },
    'react-native-gesture-handler': { Gesture: { Pan: () => gesture }, GestureDetector: 'GestureDetector' },
    'react-native-reanimated': { __esModule: true, default: fallback, cancelAnimation: () => undefined,
      runOnJS: (fn: any) => fn, withSpring: (value: number) => value, useAnimatedStyle: (fn: any) => fn(),
      useSharedValue: (value: any) => { const i = cursor++; const ref = hooks[i] ??= { value }; if (!shared.includes(ref)) shared.push(ref); return ref; } },
    '../lib/botDeck': { DECK_SPRING, releaseDeckPage, resistDeckEdge },
    '../lib/bots': { mainFirst }, '../lib/motion': { useReducedMotion: () => reduced },
    '../lib/haptics': { haptic: { selection: () => ticks++ } },
    '../lib/prefs': { usePrefs: (select: any) => select({ prefs }) },
    '../lib/store': { useApp: Object.assign((select: any) => select(store), { getState: () => store }), homeChat: (rt: any) => rt.home },
    '../lib/themeContext': { makeStyles: () => () => fallback, useTheme: () => fallback },
  };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/BotCarousel.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, { exports, require: (id: string) => modules[id] ?? fallback });
  const render = () => { cursor = 0; effects = []; const result = exports.BotCarousel({ selectedId: store.selection.serverId, activePage, focused, onPageChange: pageChanged, onAction: activate }); effects.forEach((fn) => fn()); return result; };
  render().props.onLayout({ nativeEvent: { layout: { width: 420 } } });
  let tree = render();
  const drag = (x: number, velocity = 0, cancelled = false) => {
    gesture.handlers.onStart();
    gesture.handlers.onUpdate({ translationX: x });
    gesture.handlers.onEnd({ translationX: x, velocityX: velocity }, !cancelled);
    gesture.handlers.onFinalize();
    tree = render();
  };
  return { drag, render, gesture, selections, prefs, drafts, store, hooks, ticks: () => ticks,
    page: () => shared[0].value, setPage: (value: number) => { shared[0].value = value; }, pages, actions, tree: () => tree };
}

test('mounting the controlled Add bot page does not reset to the selected bot', () => {
  const h = harness(2, false, 'add-bot');
  assert.equal(h.page(), 3);
  assert.deepEqual(h.pages, []);
  h.render(); h.render();
  assert.equal(h.page(), 3);
  assert.deepEqual(h.pages, []);
});

test('a focused composer disables the deck gesture and hides its navigation from touch and accessibility', () => {
  const h = harness(2, false, 'bot', true);
  assert.equal(h.gesture.on, false);
  assert.equal(h.tree().props.pointerEvents, 'none');
  assert.equal(h.tree().props.accessibilityElementsHidden, true);
  assert.equal(h.tree().props.style.at(-1).display, 'none', 'hidden deck is removed from native layout, independent of animation progress');
});

test('drag selects the destination home chat once, preserving the main bot and drafts', () => {
  const h = harness();
  h.drag(-150);
  assert.deepEqual(h.selections, [['bot1', 'home1']]);
  assert.equal(h.ticks(), 1);
  assert.equal(h.page(), 2);
  assert.equal(h.prefs.mainBot, 'bot0');
  assert.deepEqual(h.drafts, { 'bot0:home0': 'first draft', 'bot1:home1': 'second draft' });
});

test('tentative drags, cancellations and end resistance never switch the bot', () => {
  const h = harness();
  h.drag(-25);
  h.drag(-150, 0, true);
  assert.deepEqual(h.selections, []);
  assert.equal(h.page(), 1);
  assert.equal(h.ticks(), 0);
});

test('short flicks advance once; rapid reversals return without skipping bots', () => {
  const h = harness();
  h.drag(-14, -900);
  h.drag(14, 900);
  h.drag(-900, -5000);
  assert.deepEqual(h.selections, [['bot1', 'home1'], ['bot0', 'home0'], ['bot1', 'home1']]);
});

test('external menu selection retargets the deck; reduced motion and single bot remain usable', () => {
  const h = harness(3, true);
  h.store.selection.serverId = 'bot2';
  h.render();
  assert.equal(h.page(), 3);
  h.drag(150);
  assert.equal(h.page(), 2);
  const single = harness(1);
  assert.equal(single.gesture.on, true);
  single.drag(-150);
  assert.equal(single.page(), 2);
  assert.equal(single.pages.at(-1), 'add-bot');
  assert.deepEqual(single.selections, []);
});

test('a new gesture begins at the interrupted visual position, without jumping to the old target', () => {
  const h = harness();
  h.setPage(1.4);
  h.gesture.handlers.onStart();
  h.gesture.handlers.onUpdate({ translationX: -35 });
  assert.ok(h.page() > 1.4 && h.page() < 1.6);
  h.gesture.handlers.onFinalize();
  assert.equal(h.page(), 1);
});

test('ordinary renders preserve a drag; resizing cancels it without committing a stale destination', () => {
  const h = harness();
  h.gesture.handlers.onStart();
  h.gesture.handlers.onUpdate({ translationX: -100 });
  const tracking = h.page();
  h.render();
  assert.equal(h.page(), tracking);
  h.render().props.onLayout({ nativeEvent: { layout: { width: 600 } } });
  h.render();
  h.gesture.handlers.onEnd({ translationX: -160, velocityX: -900 }, true);
  h.gesture.handlers.onFinalize();
  assert.equal(h.page(), 1);
  assert.deepEqual(h.selections, []);
});

test('New chat is left of the main bot and Add bot follows the paired bots; swipes never invoke either action', () => {
  const h = harness(1);
  h.drag(150);
  assert.equal(h.page(), 0);
  assert.equal(h.pages.at(-1), 'new-chat');
  const changes = h.pages.length;
  h.drag(150);
  assert.equal(h.page(), 0);
  assert.equal(h.pages.length, changes, 'reselecting the active draft page must not reset its prepared chat');
  assert.deepEqual(h.actions, []);
  const frame = h.tree().props.children[0].props.children.props.children[0];
  frame.props.children.props.onPress();
  assert.deepEqual(h.actions, ['new-chat']);
  h.drag(-150);
  assert.equal(h.page(), 1);
  assert.equal(h.pages.at(-1), 'bot');
  h.drag(-150);
  assert.equal(h.page(), 2);
  assert.equal(h.pages.at(-1), 'add-bot');
  h.drag(-150);
  assert.equal(h.page(), 2);
  assert.deepEqual(h.selections, []);
  assert.equal(h.drafts['bot0:home0'], 'first draft');
});

test('edge resistance is continuous, bounded and symmetric; releases stay within the deck', () => {
  assert.equal(resistDeckEdge(1.4, 4), 1.4);
  assert.ok(resistDeckEdge(-100, 4) > -0.094);
  assert.ok(resistDeckEdge(100, 4) < 3.094);
  assert.ok(Math.abs(resistDeckEdge(-0.2, 4) + resistDeckEdge(3.2, 4) - 3) < 1e-12);
  for (let start = 0; start < 4; start++) {
    for (const travel of [-100, -0.3, 0, 0.3, 100]) {
      const next = releaseDeckPage(start, travel, travel * 10, 4);
      assert.ok(next >= 0 && next < 4 && Math.abs(next - start) <= 1);
    }
  }
});
