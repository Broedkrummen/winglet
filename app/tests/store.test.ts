import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { createStore } from 'zustand/vanilla';

class ApiError extends Error {
  status: number;
  data?: any;
  constructor(message: string, status: number, data?: any) { super(message); this.status = status; this.data = data; }
}

// Exercise the real store and helper with only transport/storage replaced. Expo native imports
// cannot run under node:test; compiling the production modules keeps the state transitions intact.
function harness(os = 'web') {
  let request: (...args: any[]) => Promise<any> = async () => ({ items: [], pending: 0 });
  let socket: any;
  let recoveryRequest = async (_: any): Promise<any> => null;
  const timers: (() => void)[] = [];
  const played: string[] = [];
  const phoneCalls: string[] = [];
  const sockets: string[] = [];
  const cache = new Map<string, any>();
  let persisted: any;
  class FakeSocket {
    readyState = 1;
    sent: any[] = [];
    onmessage?: (event: any) => void;
    onclose?: (event: any) => void;
    constructor(url: string) { socket = this; sockets.push(url); }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() {}
    event(data: any) { this.onmessage?.({ data: JSON.stringify(data) }); }
  }
  // Stands in for the ntfy subscription: "finding" an address returns whatever the test says.
  class FakeCoordinator {
    members = new Map<string, any>();
    join(id: string, m: any) { this.members.set(id, m); }
    leave(id: string) { this.members.delete(id); }
    async want(id: string) {
      const m = this.members.get(id);
      const updated = m && await recoveryRequest(m.server());
      if (!updated || this.members.get(id) !== m) return;
      recoveryRequest = async () => null; // each announcement is used once (its revision is now current)
      await m.recovered(updated);
    }
    satisfied() {}
    setForeground() {}
    setOnline() {}
    retryNow() {}
  }
  function compile(file: string, imports: Record<string, any>) {
    const exports: any = {};
    const source = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(source, {
      exports, require: (id: string) => {
        if (id in imports) return imports[id];
        throw new Error(`Unexpected import ${id}`);
      },
      WebSocket: FakeSocket, setTimeout: (fn: () => void) => { timers.push(fn); return 0; }, clearTimeout: () => {},
      setInterval: () => 0, clearInterval: () => {},
    });
    return exports;
  }
  const helpers = compile('../src/lib/messages.ts', {});
  const taskModel = compile('../src/features/execution/model.ts', {});
  const replayProtocol = compile('../src/features/event-replay/protocol.ts', {});
  const replaySession = compile('../src/features/event-replay/session.ts', { './protocol': replayProtocol });
  const replayMerge = compile('../src/features/event-replay/merge.ts', {});
  const projectHelpers = compile('../src/features/projects/logic.ts', {});
  const { useApp: store } = compile('../src/lib/store.ts', {
    zustand: { create: (fn: any) => createStore(fn) },
    'zustand/react/shallow': { useShallow: (fn: any) => fn },
    'react-native': { Platform: { OS: os } },
    './recovery': { RecoveryCoordinator: FakeCoordinator },
    '../features/phone-tools/runtime': { phoneHello: () => phoneCalls.push('hello'), phoneEvent: () => phoneCalls.push('event'), phoneDisconnect: () => phoneCalls.push('disconnect'), phoneVisibility: () => phoneCalls.push('visibility') },
    './messages': helpers,
    '../features/projects/logic': projectHelpers,
    '../features/event-replay/session': replaySession,
    '../features/event-replay/merge': replayMerge,
    './api': { api: (...args: any[]) => request(...args), ApiError, wsUrl: (s: any) => s.url,
      signedApi: (server: any, method: string, path: string, data?: unknown) =>
        request(server, path, { method, body: data === undefined ? undefined : JSON.stringify(data) }) },
    './cache': {
      cacheGet: async (key: string, fallback: any) => (cache.has(key) ? structuredClone(cache.get(key)) : fallback),
      cacheSetStrict: async (key: string, value: any) => { cache.set(key, structuredClone(value)); },
      cacheSet: async (key: string, value: any) => { cache.set(key, structuredClone(value)); },
      cacheRemove: async (prefix: string) => { for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k); },
    },
    './verify': { NEEDS_VERIFY: 'Verify this phone to do that.' },
    '../features/execution/model': taskModel,
    './sounds': { sound: { reply: () => played.push('reply'), needsYou: () => played.push('needsYou'), tap: () => {}, sent: () => {} } },
    './storage': { getJSON: async (key: string, fallback: any) => (key === 'winglet.servers' && persisted) || fallback,
      setJSON: async (key: string, value: any) => { if (key === 'winglet.servers') persisted = value; } },
  });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  return {
    store, cache, played, phoneCalls, taskModel, setRequest: (fn: typeof request) => { request = fn; },
    setRecovery: (fn: typeof recoveryRequest) => { recoveryRequest = fn; },
    disconnect: () => { socket.readyState = 3; socket.onclose?.({ code: 1006 }); },
    retry: () => timers.shift()?.(), timers, sockets, persisted: () => persisted, socket: () => socket, tick,
    event: (data: any) => socket.event(data),
    hello: async () => { socket.event({ type: 'hello', chats: [{ id: 'general', kind: 'chat', title: 'General' }], pending: 0 }); await tick(); },
    async connect() {
      await store.getState().addServer({ id: 's', url: 'http://test', token: 'test', bot: { title: 'Test' },
        ...(os === 'android' ? { recovery: { server: 'https://ntfy.sh', topic: 'private', key: 'secret', revision: 1 } } : {}) });
      store.getState().setVisibleChat({ serverId: 's', chatId: 'general' });
    },
    messages: () => store.getState().runtime.s.messages.general ?? [],
    outbox: () => store.getState().runtime.s.outbox,
  };
}

const msg = (n: number) => ({ id: `m${n}`, position: n, chat_id: 'general', role: 'bot',
  text: String(n), status: 'final', meta: {}, created_at: 1, updated_at: 1 });

/** A server that stores posted messages and answers everything else with empty lists. */
function echoServer(sent: any[], fail = () => 0) {
  return async (_: any, route: string, init?: any) => {
    if (route.endsWith('/messages') && init?.method === 'POST') {
      const body = JSON.parse(init.body);
      sent.push(body);
      const status = fail();
      if (status) throw new ApiError('nope', status);
      return { message: { id: `srv-${body.client_id}`, chat_id: 'general', role: 'user', text: body.text, status: 'final',
        meta: { client_id: body.client_id }, created_at: 2, updated_at: 2 } };
    }
    return route === '/api/inbox' ? { items: [], pending: 0 } : { messages: [], deleted_ids: [] };
  };
}

test('three equal-timestamp history pages advance through every server message', async () => {
  const h = harness();
  await h.connect();
  const all = Array.from({ length: 181 }, (_, i) => msg(i + 1));
  const cursors: (number | null)[] = [];
  h.setRequest(async (_, route) => {
    const raw = new URL(route, 'http://test').searchParams.get('before_position');
    const before = raw ? Number(raw) : null;
    cursors.push(before);
    const end = before ? all.findIndex(m => m.position === before) : all.length;
    return { messages: all.slice(Math.max(0, end - 60), end), deleted_ids: [] };
  });
  await h.store.getState().loadMessages('s', 'general');
  for (let i = 0; i < 3; i++) await h.store.getState().loadMessages('s', 'general', true);
  assert.deepEqual(cursors, [null, 122, 62, 2]);
  assert.equal(h.messages().length, 181);
  assert.equal(h.messages()[0].id, 'm1');
});

test('a page that fails to load reports it, so a jump to an old message does not read it as deleted', async () => {
  const h = harness();
  await h.connect();
  h.setRequest(async () => ({ messages: [msg(1)], deleted_ids: [] }));
  assert.equal(await h.store.getState().loadMessages('s', 'general'), true);
  h.setRequest(async () => { throw new ApiError('timed out', 504); });
  assert.equal(await h.store.getState().loadMessages('s', 'general', true), false);
  assert.equal(h.messages().length, 1);
});

test('refresh applies missed offline deletions, including previously loaded older pages', async () => {
  const h = harness();
  await h.connect();
  h.setRequest(async () => ({ messages: [msg(1), msg(2), msg(3)], deleted_ids: [] }));
  await h.store.getState().loadMessages('s', 'general');
  h.setRequest(async () => ({ messages: [msg(3)], deleted_ids: ['m1'] }));
  await h.store.getState().loadMessages('s', 'general');
  assert.equal(JSON.stringify(h.messages().map((m: any) => m.id)), JSON.stringify(['m2', 'm3']));
});

test('live delete survives a stale in-flight snapshot and subsequent stale socket updates', async () => {
  const h = harness();
  await h.connect();
  let finish: any;
  h.setRequest(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.store.getState().loadMessages('s', 'general');
  h.event({ type: 'message.delete', chat_id: 'general', message_id: 'm1' });
  h.event({ type: 'message.new', chat_id: 'general', message: msg(2) });
  finish({ messages: [msg(1)], deleted_ids: [] });
  await pending;
  h.event({ type: 'message.update', chat_id: 'general', message: msg(1) });
  assert.equal(JSON.stringify(h.messages().map((m: any) => m.id)), JSON.stringify(['m2']));
});

test('WebSocket reconnect refresh removes deletions missed while offline', async () => {
  const h = harness();
  await h.connect();
  h.setRequest(async () => ({ messages: [msg(1), msg(2)], deleted_ids: [] }));
  await h.store.getState().loadMessages('s', 'general');
  h.setRequest(async (_, route) => route === '/api/inbox' ? { items: [], pending: 0 }
    : { messages: [msg(2)], deleted_ids: ['m1'] });
  await h.hello();
  assert.equal(h.store.getState().runtime.s.status, 'online');
  assert.equal(JSON.stringify(h.messages().map((m: any) => m.id)), JSON.stringify(['m2']));
});

test('a refresh that skips past what the phone has drops the stale rows instead of leaving a gap', async () => {
  const h = harness();
  await h.connect();
  h.setRequest(async () => ({ messages: [msg(1), msg(2)], deleted_ids: [] }));
  await h.store.getState().loadMessages('s', 'general');
  // More than a page arrived while disconnected: the new first page doesn't touch m1/m2.
  const page = Array.from({ length: 60 }, (_, i) => msg(i + 100));
  h.setRequest(async (_, route) => route === '/api/inbox' ? { items: [], pending: 0 } : { messages: page, deleted_ids: [] });
  await h.hello();
  assert.equal(h.messages()[0].id, 'm100');
  assert.equal(h.messages().length, 60);
});

test('Android reconnect updates and persists a recovered URL without losing history or pairing', async () => {
  const h = harness('android');
  await h.connect();
  h.setRequest(async () => ({ messages: [msg(1)], deleted_ids: [] }));
  await h.store.getState().loadMessages('s', 'general');
  h.setRequest(async () => { throw new Error('old endpoint gone'); });
  h.setRecovery(async (s: any) => ({ ...s, url: 'https://new.trycloudflare.com', recovery: { ...s.recovery, revision: 2 } }));
  h.disconnect();
  await h.tick();
  assert.equal(h.store.getState().servers[0].url, 'https://new.trycloudflare.com');
  assert.equal(h.persisted()[0].recovery.revision, 2);
  assert.equal(h.store.getState().servers[0].token, 'test');
  assert.equal(h.messages()[0].id, 'm1');
  assert.equal(h.sockets.at(-1), 'https://new.trycloudflare.com');
});

test('removing a server during recovery prevents a stale result from reconnecting it', async () => {
  const h = harness('android');
  await h.connect();
  h.setRequest(async () => { throw new Error('offline'); });
  let finish: any;
  h.setRecovery((s: any) => new Promise(resolve => { finish = () => resolve({ ...s, url: 'https://new.trycloudflare.com' }); }));
  h.disconnect();
  await h.tick();
  await h.store.getState().removeServer('s', false);
  finish();
  await h.tick();
  assert.equal(h.store.getState().servers.length, 0);
  assert.equal(h.sockets.length, 1);
});

test('a socket that stays silent after returning to the foreground is replaced, and recovery runs', async () => {
  const h = harness('android');
  await h.connect();
  await h.hello();
  h.timers.length = 0;
  h.setRecovery(async (s: any) => ({ ...s, url: 'https://new.trycloudflare.com' }));
  h.store.getState().setForeground(true);
  assert.equal(h.socket().sent.at(-1).type, 'ping');
  h.retry(); // no pong within the deadline
  await h.tick();
  assert.equal(h.store.getState().servers[0].url, 'https://new.trycloudflare.com');
  assert.equal(h.sockets.at(-1), 'https://new.trycloudflare.com');
});

test('a socket that answers after returning to the foreground is kept', async () => {
  const h = harness('android');
  await h.connect();
  await h.hello();
  h.timers.length = 0;
  h.store.getState().setForeground(true);
  h.event({ type: 'pong' });
  const before = h.sockets.length;
  h.retry(); // the deadline fires after the pong: nothing happens
  await h.tick();
  assert.equal(h.sockets.length, before);
  assert.equal(h.store.getState().runtime.s.status, 'online');
});

test('messages sent offline are queued, then delivered in order with their original ids', async () => {
  const h = harness();
  await h.connect();
  h.disconnect();
  const sent: any[] = [];
  h.setRequest(echoServer(sent));
  await h.store.getState().sendMessage('s', 'general', 'one');
  await h.store.getState().sendMessage('s', 'general', 'two');
  assert.equal(JSON.stringify(h.messages().map((m: any) => m.status)), JSON.stringify(['queued', 'queued']));
  assert.equal(h.cache.get('outbox:s').length, 2);
  assert.equal(sent.length, 0);
  h.retry(); // reconnect
  await h.hello();
  await h.tick();
  assert.deepEqual(sent.map((b) => b.text), ['one', 'two']);
  assert.equal(h.outbox().length, 0);
  assert.equal(JSON.stringify(h.messages().map((m: any) => m.status)), JSON.stringify(['final', 'final']));
  assert.equal(sent[0].client_id, h.messages()[0].meta.client_id);
});

test('a send whose reply is lost is retried with the same id, so the server can de-duplicate it', async () => {
  const h = harness();
  await h.connect();
  await h.hello();
  const sent: any[] = [];
  let failing = true;
  // A network error (no HTTP status) on the first attempt.
  h.setRequest(async (a: any, route: string, init?: any) => {
    if (failing && init?.method === 'POST') { sent.push(JSON.parse(init.body)); throw new ApiError('lost', 0); }
    return echoServer(sent)(a, route, init);
  });
  await h.store.getState().sendMessage('s', 'general', 'hello');
  assert.equal(h.messages()[0].status, 'queued');
  failing = false;
  await h.hello();
  await h.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].client_id, sent[1].client_id);
  assert.equal(h.messages().length, 1);
  assert.equal(h.messages()[0].status, 'final');
});

test('a message the server refuses fails, and can be deleted', async () => {
  const h = harness();
  await h.connect();
  await h.hello();
  h.setRequest(echoServer([], () => 404));
  await h.store.getState().sendMessage('s', 'general', 'nope');
  const failed = h.messages()[0];
  assert.equal(failed.status, 'failed');
  assert.equal(h.outbox()[0].failed, true);
  h.store.getState().discardMessage('s', 'general', failed.id);
  assert.equal(h.messages().length, 0);
  assert.equal(h.outbox().length, 0);
});

test('drafts are kept per chat and cleared when empty', async () => {
  const h = harness();
  await h.connect();
  h.store.getState().setDraft('s', 'general', 'half a thought');
  h.store.getState().setDraft('s', 'other', 'elsewhere');
  assert.equal(h.store.getState().drafts['s:general'], 'half a thought');
  h.store.getState().setDraft('s', 'general', '');
  assert.equal('s:general' in h.store.getState().drafts, false);
  assert.equal(h.store.getState().drafts['s:other'], 'elsewhere');
});

test('after a restart, cached messages show at once and the queued outbox is still there', async () => {
  const h = harness();
  await h.connect(); // remembers the server, as a previous run would have
  h.cache.set('msgs:s:general', [msg(1), msg(2)]);
  h.cache.set('outbox:s', [{ client_id: 'c-1', chat_id: 'general', text: 'later', created_at: 5 }]);
  await h.store.getState().init();
  await h.store.getState().hydrateChat('s', 'general');
  assert.equal(JSON.stringify(h.messages().map((m: any) => m.id)), JSON.stringify(['m1', 'm2', 'c-1']));
  assert.equal(h.messages()[2].status, 'queued');
  assert.equal(h.outbox().length, 1);
});

test('the protocol check flags an app that is too old for its server', async () => {
  const h = harness();
  await h.connect();
  h.event({ type: 'hello', chats: [], pending: 0, version: '9.0.0', protocol: 5, min_app_protocol: 4, hermes_version: 'x' });
  await h.tick();
  const rt = h.store.getState().runtime.s;
  assert.equal(rt.compat, 'update-app');
  assert.equal(rt.info.hermes_version, 'x');
});

test("the agent's pet loads on connect, follows changes, and is remembered for offline starts", async () => {
  const h = harness();
  await h.connect();
  const boba = { slug: 'boba', name: 'Boba', sheet_url: '/api/pets/boba/sheet?rev=1&sig=x' };
  let pet: any = boba;
  const asked: string[] = [];
  h.setRequest(async (_, route) => {
    asked.push(route);
    return route === '/api/pet' ? { pet } : { items: [], pending: 0, messages: [], deleted_ids: [] };
  });
  // A server without pets isn't asked, and shows the orb.
  await h.hello();
  assert.equal(h.store.getState().runtime.s.pet, null);
  assert.ok(!asked.includes('/api/pet'));

  h.event({ type: 'hello', chats: [], pending: 0, features: { pets: true } });
  await h.tick();
  assert.equal(h.store.getState().runtime.s.pet.slug, 'boba');
  assert.equal(h.cache.get('pet:s').slug, 'boba');

  pet = null;
  h.event({ type: 'pet.update' });
  await h.tick();
  assert.equal(h.store.getState().runtime.s.pet, null);

  // Offline, the face stays as it was.
  pet = boba;
  h.event({ type: 'pet.update' });
  await h.tick();
  h.setRequest(async () => { throw new ApiError('offline', 0); });
  h.event({ type: 'pet.update' });
  await h.tick();
  assert.equal(h.store.getState().runtime.s.pet.slug, 'boba');
});

test('an older pet answer that arrives late never replaces a newer one, on screen or in the cache', async () => {
  const h = harness();
  await h.connect();
  const answers: ((pet: any) => void)[] = [];
  h.setRequest(async (_, route) => (route === '/api/pet'
    ? new Promise((resolve) => answers.push((pet) => resolve({ pet })))
    : { items: [], pending: 0, messages: [], deleted_ids: [] }));
  h.event({ type: 'hello', chats: [], pending: 0, features: { pets: true } });
  await h.tick();
  h.event({ type: 'pet.update' }); // the pet was switched off while the first request was out
  await h.tick();
  assert.equal(answers.length, 2);
  answers[1](null);
  await h.tick();
  answers[0]({ slug: 'boba', name: 'Boba' });
  await h.tick();
  assert.equal(h.store.getState().runtime.s.pet, null);
  assert.equal(h.cache.get('pet:s'), null);
});

test("a server's other bots appear as bots of their own, follow its address, and go with it", async () => {
  const h = harness();
  await h.connect();
  const asked: string[] = [];
  h.setRequest(async (server: any, route: string) => { asked.push(`${server.id} ${route}`); return { items: [], pending: 0, messages: [], deleted_ids: [] }; });
  const mainSocket = h.socket();
  h.event({ type: 'hello', chats: [], pending: 0, features: {}, bots: [{ name: 'chef', title: 'Chef', description: 'Meals' }] });
  await h.tick();
  const ids = () => Array.from(h.store.getState().servers, (s: any) => s.id);
  assert.deepEqual(ids(), ['s', 's~chef']);
  const chef = h.store.getState().servers[1];
  assert.equal(chef.profile, 'chef');
  assert.equal(chef.parent, 's');
  assert.equal(chef.bot.title, 'Chef');
  assert.equal(chef.token, 'test');
  assert.ok(h.sockets.length >= 2, 'it has a socket of its own');
  // Renamed in Hermes, and another made: the list follows.
  mainSocket.event({ type: 'system.bots', bots: [{ name: 'chef', title: 'Head Chef', description: '' }, { name: 'scout', title: 'Scout', description: '' }] });
  await h.tick();
  assert.deepEqual(ids(), ['s', 's~chef', 's~scout']);
  assert.equal(h.store.getState().servers[1].bot.title, 'Head Chef');
  // The server moved: its bots move with it.
  await h.store.getState().updateServer('s', { url: 'http://moved', token: 'new' });
  assert.ok(h.store.getState().servers.every((s: any) => s.url === 'http://moved' && s.token === 'new'));
  // A bot deleted on the server leaves the app without unpairing anything.
  mainSocket.event({ type: 'system.bots', bots: [{ name: 'scout', title: 'Scout', description: '' }] });
  await h.tick();
  assert.deepEqual(ids(), ['s', 's~scout']);
  assert.ok(!asked.some((a) => a.includes('/api/me')), 'no unpair');
  // Removing the server removes its bots.
  await h.store.getState().removeServer('s', false);
  assert.deepEqual(ids(), []);
});

test('a streamed edit replaces only its own row and keeps the others as they were', async () => {
  const h = harness();
  await h.connect();
  h.setRequest(async () => ({ messages: [msg(1), msg(2), msg(3)], deleted_ids: [] }));
  await h.store.getState().loadMessages('s', 'general');
  const before = h.messages();
  h.event({ type: 'message.update', chat_id: 'general', message: { ...before[1], text: 'streaming…', status: 'streaming', updated_at: before[1].updated_at + 1 } });
  const after = h.messages();
  assert.equal(after[0], before[0]);
  assert.equal(after[2], before[2]);
  assert.equal(after[1].text, 'streaming…');
  assert.equal(after[1].position, before[1].position);
  // An older copy arriving late changes nothing.
  h.event({ type: 'message.update', chat_id: 'general', message: { ...before[1], text: 'stale' } });
  assert.equal(h.messages()[1].text, 'streaming…');
});

test("Hermes's progress bubbles don't end the turn; its reply does", async () => {
  const h = harness();
  await h.connect();
  await h.hello();
  const typing = () => !!h.store.getState().runtime.s.typing.general;
  const bot = (id: string, text: string) => ({ ...msg(1), id, text });
  h.event({ type: 'typing', chat_id: 'general', on: true });
  // Both wordings of tool progress arrive as final messages while the bot is still at work.
  h.event({ type: 'message.new', chat_id: 'general', message: bot('p1', '🔍 web_search: "cats"') });
  assert.ok(typing());
  h.event({ type: 'message.new', chat_id: 'general', message: bot('p2', '🔍 Searching the web for cats') });
  assert.ok(typing());
  h.event({ type: 'message.new', chat_id: 'general', message: bot('r', 'There are three breeds.') });
  assert.ok(!typing());
});

test('a reply chimes once, when its turn ends in the chat on screen', async () => {
  const h = harness();
  await h.connect();
  await h.hello();
  h.event({ type: 'typing', chat_id: 'general', on: true });
  h.event({ type: 'message.new', chat_id: 'general', message: { ...msg(1), status: 'streaming' } });
  h.event({ type: 'message.update', chat_id: 'general', message: msg(1) });
  h.event({ type: 'message.update', chat_id: 'general', message: msg(1) }); // repeated final: no second chime
  assert.deepEqual(h.played, ['reply']);
  // A reply in a chat you aren't looking at toasts instead.
  h.event({ type: 'typing', chat_id: 'other', on: true });
  h.event({ type: 'message.new', chat_id: 'other', message: { ...msg(2), chat_id: 'other' } });
  assert.deepEqual(h.played, ['reply']);
});

test('a replayed final reply cannot end a newer working turn or chime again', async () => {
  const h = harness();
  await h.connect(); await h.hello();
  h.event({ type: 'typing', chat_id: 'general', on: true });
  h.event({ type: 'message.new', chat_id: 'general', message: msg(1) });
  h.event({ type: 'typing', chat_id: 'general', on: true });
  const lastReply = h.store.getState().runtime.s.lastReplyAt;
  h.event({ type: 'message.update', chat_id: 'general', message: msg(1) });
  assert.ok(h.store.getState().runtime.s.typing.general);
  assert.equal(h.store.getState().runtime.s.lastReplyAt, lastReply);
  assert.deepEqual(h.played, ['reply']);
});

test('something needing you chimes while the app is open', async () => {
  const h = harness();
  await h.connect();
  await h.hello();
  h.event({ type: 'inbox.new', item: { id: 'q1', kind: 'question', status: 'pending', title: 'Which one?', body: '', created_at: 1, chat_id: 'general' }, pending: 1 });
  assert.deepEqual(h.played, ['needsYou']);
});

test('streaming pauses, tool progress and repeated finals do not flood the toast stack', async () => {
  const h = harness();
  await h.connect(); await h.hello();
  h.store.getState().setVisibleChat(undefined);
  const streaming = { ...msg(1), status: 'streaming', text: 'Half an answer' };
  h.event({ type: 'message.new', chat_id: 'general', message: streaming });
  for (const meta of [{ activity: true }, { inbox_id: 'approval' }, { notify: false }]) {
    h.event({ type: 'message.new', chat_id: 'general', message: { ...msg(2), id: JSON.stringify(meta), meta } });
  }
  assert.equal(h.store.getState().toasts.length, 0);
  h.event({ type: 'message.update', chat_id: 'general', message: { ...msg(1), text: 'Finished answer', updated_at: 2 } });
  assert.equal(h.store.getState().toasts.length, 1);
  h.event({ type: 'message.update', chat_id: 'general', message: { ...msg(1), text: 'Finished answer', updated_at: 2 } });
  assert.equal(h.store.getState().toasts.length, 1);
});

test('background replies and stale inbox events do not replay alerts on returning', async () => {
  const h = harness();
  await h.connect(); await h.hello();
  h.store.getState().setVisibleChat(undefined);
  h.store.getState().setForeground(false);
  h.event({ type: 'message.new', chat_id: 'general', message: msg(1) });
  h.event({ type: 'inbox.new', item: { id: 'q', kind: 'question', status: 'pending', title: 'Which?', body: '' } });
  h.store.getState().setForeground(true);
  h.event({ type: 'inbox.new', item: { id: 'old', kind: 'question', status: 'expired', title: 'Which?', body: '' } });
  assert.equal(h.store.getState().toasts.length, 0);
  assert.deepEqual(h.played, []);
});

test('model and thinking controls do not end a working turn, chime or toast as replies', async () => {
  const h = harness();
  await h.connect(); await h.hello();
  h.store.getState().setVisibleChat(undefined);
  h.event({ type: 'typing', chat_id: 'general', on: true });
  for (const kind of ['model', 'choice']) {
    h.event({ type: 'message.new', chat_id: 'general', message: {
      ...msg(1), id: kind, text: 'Choose a setting', meta: { picker: { kind, status: 'open' } },
    } });
  }
  assert.ok(h.store.getState().runtime.s.typing.general);
  assert.equal(h.store.getState().runtime.s.lastReplyAt ?? 0, 0);
  assert.deepEqual(h.played, []);
  assert.equal(h.store.getState().toasts.length, 0);
});

test('removing a bot clears its complete composer state and ignores late history and inbox responses', async () => {
  const h = harness();
  await h.connect();
  h.store.getState().setDraft('s', 'general', 'Private draft');
  h.store.getState().setDraft('other', 'general', 'Keep this');
  h.store.getState().setReplyTo('s', 'general', { id: 'm1', role: 'bot', text: 'Private context' });
  h.store.getState().updateDraftFiles('s', 'general', () => [{ localId: 'file', status: 'ready' }]);
  const pending: ((value: any) => void)[] = [];
  h.setRequest(() => new Promise(resolve => pending.push(resolve)));
  const history = h.store.getState().loadMessages('s', 'general');
  const inbox = h.store.getState().loadInbox('s');
  await h.store.getState().removeServer('s', false);
  for (const resolve of pending) resolve({ messages: [msg(1)], items: [], pending: 0 });
  await Promise.all([history, inbox]);
  const state = h.store.getState();
  assert.equal(state.runtime.s, undefined);
  assert.equal(state.drafts['s:general'], undefined);
  assert.equal(state.draftFiles['s:general'], undefined);
  assert.equal(state.replyTo['s:general'], undefined);
  assert.equal(state.visibleChat, undefined);
  assert.equal(state.drafts['other:general'], 'Keep this');
});

test('deleting a chat drops its draft, attachment tray and reply without clearing another chat', async () => {
  const h = harness();
  await h.connect();
  h.store.getState().setDraft('s', 'general', 'Remove this');
  h.store.getState().setDraft('s', 'another', 'Keep this');
  h.store.getState().setReplyTo('s', 'general', { id: 'm1', role: 'bot', text: 'Context' });
  h.store.getState().updateDraftFiles('s', 'general', () => [{ localId: 'file' }]);
  h.setRequest(async () => ({}));
  await h.store.getState().deleteChat('s', 'general');
  const state = h.store.getState();
  assert.equal(state.drafts['s:general'], undefined);
  assert.equal(state.replyTo['s:general'], undefined);
  assert.equal(state.draftFiles['s:general'], undefined);
  assert.equal(state.drafts['s:another'], 'Keep this');
});

test('the composer restores its saved reply context after restart', async () => {
  const h = harness();
  const reply = { id: 'reply', role: 'bot', text: 'Remember this question' };
  h.cache.set('replyTo', { 's:general': reply });
  await h.store.getState().init();
  assert.equal(JSON.stringify(h.store.getState().replyTo['s:general']), JSON.stringify(reply));
});

test('an acknowledged send with a lost HTTP response does not pause the following message', async () => {
  const h = harness();
  await h.connect(); await h.hello();
  const sent: any[] = [];
  h.setRequest(async (_, route, init) => {
    if (!init?.method) return { messages: [], deleted_ids: [] };
    const body = JSON.parse(init.body);
    sent.push(body);
    const message = { ...msg(sent.length), role: 'user', text: body.text, meta: { client_id: body.client_id } };
    if (sent.length === 1) {
      h.event({ type: 'message.new', chat_id: 'general', message });
      throw new ApiError('HTTP response lost after acceptance', 0);
    }
    return { message };
  });
  await h.store.getState().sendMessage('s', 'general', 'Accepted first');
  await h.store.getState().sendMessage('s', 'general', 'Send next');
  assert.equal(sent.length, 2);
  assert.equal(h.outbox().length, 0);
  assert.equal(h.messages().length, 2);
  assert.ok(h.messages().every((m: any) => m.status === 'final'));
  await h.store.getState().sendMessage('s', 'general', 'Accepted first', sent[0].client_id);
  assert.equal(sent.length, 2, 'a stale Retry callback cannot resubmit an accepted prompt');
});

test('server refusal details survive a restart and a retry reuses the files, reply and delivery ID', async () => {
  const h = harness();
  await h.connect(); await h.hello();
  const attachments = [{ id: 'upload', url: '/media/upload', name: 'file.pdf' }];
  const replyTo = { id: 'quoted', role: 'bot', text: 'The question' };
  h.setRequest(async () => { throw new ApiError('The attachment expired. Attach it again.', 400); });
  await h.store.getState().sendMessage('s', 'general', 'Read this', { attachments, replyTo });
  assert.equal(h.messages()[0].meta.delivery_error, 'The attachment expired. Attach it again.');
  assert.equal(h.cache.get('outbox:s')[0].failure, 'The attachment expired. Attach it again.');
  const clientId = h.outbox()[0].client_id;
  let payload: any;
  h.setRequest(async (_, _route, init) => {
    payload = JSON.parse(init.body);
    return { message: { ...msg(1), role: 'user', meta: { client_id: payload.client_id } } };
  });
  await h.store.getState().sendMessage('s', 'general', 'Read this', clientId);
  assert.equal(payload.client_id, clientId);
  assert.equal(payload.reply_to, 'quoted');
  assert.equal(JSON.stringify(payload.attachments), JSON.stringify(['upload']));
  assert.equal(h.outbox().length, 0);
});

test('an inbox snapshot cannot revive an answered request or hide a question received in flight', async () => {
  const h = harness();
  await h.connect(); await h.hello();
  const question = { id: 'q', kind: 'question', status: 'pending', chat_id: 'general', updated_at: 1 };
  h.event({ type: 'inbox.new', item: question, pending: 1 });
  let resolve!: (value: any) => void;
  h.setRequest(() => new Promise((done) => { resolve = done; }));
  const loading = h.store.getState().loadInbox('s');
  h.event({ type: 'inbox.update', item: { ...question, status: 'resolved' }, pending: 0 });
  h.event({ type: 'inbox.new', item: { ...question, id: 'new' }, pending: 1 });
  resolve({ items: [question], pending: 1 });
  await loading;
  assert.equal(h.store.getState().runtime.s.inbox.q.status, 'resolved');
  assert.equal(h.store.getState().runtime.s.inbox.new.status, 'pending');
  assert.equal(h.store.getState().runtime.s.pending, 1);
});

const projectSnapshot = (name = 'Launch', revision = 1, layout = 2) => ({
  projects: [{ id: 'p1', name, position: 1000, archived: false, revision, private: false, can_manage: true,
    chat_count: 1, created_at: 1, updated_at: 1 }],
  threads: [{ chat_id: 'general', project_id: 'p1', position: 1000 }],
  layout_revision: layout,
});

test('hello and project.sync carry server project structure into the store and its cache', async () => {
  const h = harness();
  await h.connect();
  h.event({ type: 'hello', chats: [{ id: 'general', kind: 'chat', title: 'General' }], pending: 0,
    features: { projects: true }, projects: projectSnapshot() });
  await h.tick();
  assert.equal(h.store.getState().runtime.s.projects?.projects[0].name, 'Launch');
  assert.equal(h.store.getState().runtime.s.projects?.threads[0].chat_id, 'general');
  h.event({ type: 'project.sync', projects: projectSnapshot('Renamed', 2, 2) });
  await h.tick();
  assert.equal(h.store.getState().runtime.s.projects?.projects[0].name, 'Renamed');
  assert.equal(h.cache.get('projects:s').projects[0].name, 'Renamed');
});

test('a stale project rename rolls back and adopts the server snapshot', async () => {
  const h = harness();
  await h.connect();
  h.event({ type: 'hello', chats: [{ id: 'general', kind: 'chat', title: 'General' }], pending: 0,
    features: { projects: true }, projects: projectSnapshot() });
  await h.tick();
  h.setRequest(async () => { throw new ApiError('changed elsewhere', 409, { projects: projectSnapshot('Theirs', 3, 2) }); });
  await assert.rejects(h.store.getState().renameProject('s', 'p1', 'Mine'));
  assert.equal(h.store.getState().runtime.s.projects?.projects[0].name, 'Theirs');
  assert.equal(h.store.getState().runtime.s.projects?.projects[0].revision, 3);
});

test('moving a chat sends both revisions and puts the old membership back if the server refuses', async () => {
  const h = harness();
  await h.connect();
  h.event({ type: 'hello', chats: [{ id: 'general', kind: 'chat', title: 'General' },
    { id: 'c1', kind: 'chat', title: 'Topic' }], pending: 0,
    features: { projects: true }, projects: {
      projects: [{ ...projectSnapshot().projects[0] },
        { ...projectSnapshot().projects[0], id: 'p2', name: 'Other', position: 2000, chat_count: 0 }],
      threads: [{ chat_id: 'c1', project_id: 'p1', position: 1000 }], layout_revision: 2 } });
  await h.tick();
  const calls: any[] = [];
  h.setRequest(async (_server: any, route: string, init: any) => { calls.push({ route, body: JSON.parse(init.body) }); throw new ApiError('offline', 0); });
  await assert.rejects(h.store.getState().moveChatToProject('s', 'c1', 'p2'));
  assert.equal(h.store.getState().runtime.s.projects?.threads.find((t) => t.chat_id === 'c1')?.project_id, 'p1');
  assert.equal(calls[0].route, '/api/projects/p2/chats/c1');
  assert.equal(calls[0].body.from_project_id, 'p1');
  assert.equal(calls[0].body.from_revision, 1);
});

test('starting a chat inside a project sends its revision and keeps the new chat', async () => {
  const h = harness();
  await h.connect();
  h.event({ type: 'hello', chats: [{ id: 'general', kind: 'chat', title: 'General' }], pending: 0,
    features: { projects: true }, projects: projectSnapshot('Launch', 2, 2) });
  await h.tick();
  const calls: any[] = [];
  const after = { ...projectSnapshot('Launch', 3, 2), threads: [{ chat_id: 'c-new', project_id: 'p1', position: 1000 }] };
  h.setRequest(async (_server: any, route: string, init: any) => {
    calls.push({ route, body: JSON.parse(init.body) });
    return { chat: { id: 'c-new', title: 'Fresh', kind: 'chat', created_at: 1, updated_at: 1, preview: '' }, projects: after };
  });
  const chat = await h.store.getState().createChatInProject('s', 'p1', 'Fresh');
  assert.equal(chat?.id, 'c-new');
  assert.equal(calls[0].route, '/api/projects/p1/chats');
  assert.equal(calls[0].body.revision, 2);
  assert.equal(calls[0].body.title, 'Fresh');
  assert.equal(h.store.getState().runtime.s.chats['c-new'].title, 'Fresh');
  assert.equal(h.store.getState().runtime.s.projects?.threads[0].chat_id, 'c-new');
});

test('project snapshots never disturb an unsent draft', async () => {
  const h = harness();
  await h.connect();
  h.store.getState().setDraft('s', 'general', 'unsent words');
  h.event({ type: 'hello', chats: [{ id: 'general', kind: 'chat', title: 'General' }], pending: 0,
    features: { projects: true }, projects: projectSnapshot() });
  await h.tick();
  h.event({ type: 'project.sync', projects: projectSnapshot('Moved', 4, 3) });
  await h.tick();
  assert.equal(h.store.getState().drafts['s:general'], 'unsent words');
});

test('overlapping inbox loads apply only the latest requested snapshot', async () => {
  const h = harness();
  await h.connect(); await h.hello();
  const resolve: ((value: any) => void)[] = [];
  h.setRequest(() => new Promise((done) => resolve.push(done)));
  const first = h.store.getState().loadInbox('s');
  const second = h.store.getState().loadInbox('s');
  resolve[1]({ items: [], pending: 0 });
  await second;
  resolve[0]({ items: [{ id: 'stale', kind: 'question', status: 'pending' }], pending: 1 });
  await first;
  assert.equal(h.store.getState().runtime.s.pending, 0);
  assert.equal(Object.keys(h.store.getState().runtime.s.inbox).length, 0);
});

test('task activity stays per chat, ignores a stale snapshot, and starts fresh on hello', async () => {
  const h = harness();
  await h.connect();
  const base = h.taskModel.emptyTask('general');
  h.event({ type: 'task.snapshot', chat_id: 'general',
    snapshot: { ...base, turn_index: 1, turn_id: 't1', state: 'running', started_at: 1, updated_at: 2, seq: 1 } });
  const tool = { id: 'call-1', name: 'terminal', preview: 'ls', status: 'running', started_at: 2,
    ended_at: null, duration_ms: null, error: null, started_known: true };
  h.event({ type: 'task.event', chat_id: 'general', turn_id: 't1', turn_index: 1, seq: 2,
    event: { kind: 'tool.started', tool } });
  assert.equal(h.store.getState().runtime.s.tasks.general.tools[0].id, 'call-1');

  // A slow refetch that predates the live fact cannot erase it.
  h.event({ type: 'task.snapshot', chat_id: 'general',
    snapshot: { ...base, turn_index: 1, turn_id: 't1', state: 'running', updated_at: 3, seq: 1 } });
  assert.equal(h.store.getState().runtime.s.tasks.general.tools.length, 1);

  // Another chat's task is independent.
  h.event({ type: 'task.snapshot', chat_id: 'side',
    snapshot: { ...h.taskModel.emptyTask('side'), turn_index: 1, state: 'completed', updated_at: 3, ended_at: 3, seq: 1 } });
  assert.equal(h.store.getState().runtime.s.tasks.side.state, 'completed');
  assert.equal(h.store.getState().runtime.s.tasks.general.tools.length, 1);

  // A newer snapshot settles this chat.
  h.event({ type: 'task.snapshot', chat_id: 'general',
    snapshot: { ...base, turn_index: 1, turn_id: 't1', state: 'completed', updated_at: 4, ended_at: 4, seq: 3 } });
  assert.equal(h.store.getState().runtime.s.tasks.general.state, 'completed');

  await h.hello();
  assert.equal(Object.keys(h.store.getState().runtime.s.tasks).length, 0);
});

test('a late project read cannot roll back live project changes', async () => {
  const h = harness();
  await h.connect();
  h.event({ type: 'hello', chats: [], features: { projects: true }, projects: projectSnapshot() });
  await h.tick();
  let resolve!: (value: any) => void;
  h.setRequest(() => new Promise((done) => { resolve = done; }));
  const loading = h.store.getState().loadProjects('s');
  h.event({ type: 'project.sync', projects: projectSnapshot('Live', 4, 2) });
  resolve({ projects: projectSnapshot('Old', 1, 2) });
  await loading;
  assert.equal(h.store.getState().runtime.s.projects?.projects[0].name, 'Live');
});

test('failed optimistic project changes preserve a newer socket snapshot', async () => {
  const h = harness();
  await h.connect();
  h.event({ type: 'hello', chats: [], features: { projects: true }, projects: projectSnapshot() });
  await h.tick();
  let reject!: (reason: any) => void;
  h.setRequest(() => new Promise((_, fail) => { reject = fail; }));
  const renaming = h.store.getState().renameProject('s', 'p1', 'Mine');
  h.event({ type: 'project.sync', projects: projectSnapshot('Newest', 5, 2) });
  reject(new ApiError('lost connection', 0));
  await assert.rejects(renaming);
  assert.equal(h.store.getState().runtime.s.projects?.projects[0].name, 'Newest');
  assert.equal(h.cache.get('projects:s').projects[0].name, 'Newest');
});

test('a stale conflict response cannot replace a newer live project snapshot', async () => {
  const h = harness();
  await h.connect();
  h.event({ type: 'hello', chats: [], features: { projects: true }, projects: projectSnapshot() });
  await h.tick();
  let reject!: (reason: any) => void;
  h.setRequest(() => new Promise((_, fail) => { reject = fail; }));
  const renaming = h.store.getState().renameProject('s', 'p1', 'Mine');
  h.event({ type: 'project.sync', projects: projectSnapshot('Newest', 5, 2) });
  reject(new ApiError('old conflict', 409, { projects: projectSnapshot('Older', 3, 2) }));
  await assert.rejects(renaming);
  assert.equal(h.store.getState().runtime.s.projects?.projects[0].name, 'Newest');
});

test('a late project response cannot recreate a removed bot cache', async () => {
  const h = harness();
  await h.connect();
  h.event({ type: 'hello', chats: [], features: { projects: true }, projects: projectSnapshot() });
  await h.tick();
  let resolve!: (value: any) => void;
  h.setRequest(() => new Promise((done) => { resolve = done; }));
  const loading = h.store.getState().loadProjects('s');
  await h.store.getState().removeServer('s', false);
  resolve({ projects: projectSnapshot('Late', 2, 2) });
  await loading;
  assert.equal(h.store.getState().runtime.s, undefined);
  assert.equal(h.cache.has('projects:s'), false);
});

test('overlapping project reads only apply the latest requested snapshot', async () => {
  const h = harness();
  await h.connect();
  h.event({ type: 'hello', chats: [], features: { projects: true }, projects: projectSnapshot() });
  await h.tick();
  const resolves: ((value: any) => void)[] = [];
  h.setRequest(() => new Promise((done) => resolves.push(done)));
  const first = h.store.getState().loadProjects('s');
  const second = h.store.getState().loadProjects('s');
  resolves[1]({ projects: projectSnapshot('Latest', 3, 2) });
  await second;
  resolves[0]({ projects: projectSnapshot('Old', 2, 2) });
  await first;
  assert.equal(h.store.getState().runtime.s.projects?.projects[0].name, 'Latest');
});

test('phone bridge starts only with capability, receives scoped events and closes with the connection',async()=>{
 const h=harness('android');await h.connect();await h.hello();assert.equal(h.phoneCalls.includes('hello'),false);
 h.event({type:'hello',chats:[],features:{phone_tools:true}});await h.tick();assert.equal(h.phoneCalls.includes('hello'),true);
 h.event({type:'phone_tool.cancel',id:'synthetic'});assert.equal(h.phoneCalls.at(-1),'event');
 h.store.getState().setForeground(false);assert.equal(h.phoneCalls.includes('visibility'),true);
 await h.store.getState().removeServer('s');assert.equal(h.phoneCalls.includes('disconnect'),true);
});

test('real socket replay persists applied messages with its cursor and suppresses catch-up alerts', async () => {
  const h = harness(); await h.connect();
  h.cache.set('replay:s', { cursor: { scope: 'scope', epoch: 'epoch', cursor: 0 }, state: {
    chats: { general: { id: 'general', kind: 'chat', title: 'General' } }, messages: {}, deleted: {}, loaded: {},
    inbox: {}, pending: 0, tasks: {},
  } });
  await h.store.getState().init();
  h.setRequest(async (_, route) => route === '/api/inbox' ? { items: [], pending: 0 } : { messages: [], deleted_ids: [] });
  h.event({ type: 'hello', chats: [{ id: 'general', kind: 'chat', title: 'General' }], pending: 0,
    features: { event_replay: true }, event_stream: { scope: 'scope', epoch: 'epoch', watermark: 1 } });
  await h.tick();
  assert.equal(h.socket().sent.at(-1).type, 'resume');
  h.event({ type: 'resume', ok: true, scope: 'scope', epoch: 'epoch', watermark: 1, cursor: 1, has_more: false,
    events: [{ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(9) }] });
  await h.tick();
  const checkpoint = h.cache.get('replay:s');
  assert.equal(checkpoint.cursor.cursor, 1); assert.equal(checkpoint.state.messages.general[0].id, 'm9');
  assert.equal(h.store.getState().runtime.s.sync.phase, 'idle'); assert.equal(h.played.length, 0);
});


test('snapshot recovery follows the verified recovered address rather than the original socket address', async () => {
  const h = harness('android'); await h.connect();
  h.setRecovery(async (s: any) => ({ ...s, url: 'https://recovered.example.test', recovery: { ...s.recovery, revision: 2 } }));
  h.disconnect(); await h.tick();
  const reads: any[] = [];
  h.setRequest(async (s, route) => {
    reads.push([s.url, route]);
    if (route === '/api/sync/snapshot') return { server_id: 'server', bot: null, scope: 'scope', epoch: 'epoch',
      watermark: 0, chats: [{ id: 'general', kind: 'chat', title: 'General' }], inbox: [], pending: 0, deletions: {} };
    return route === '/api/inbox' ? { items: [], pending: 0 } : { messages: [], deleted_ids: [] };
  });
  h.event({ type: 'hello', chats: [{ id: 'general', kind: 'chat', title: 'General' }], features: { event_replay: true },
    event_stream: { scope: 'scope', epoch: 'epoch', watermark: 0 } });
  await h.tick();
  assert.equal(reads.find(([, route]) => route === '/api/sync/snapshot')[0], 'https://recovered.example.test');
});

test('exact quote delivery carries its typed anchor and selected text only', async () => {
  const h = harness(); await h.connect(); await h.hello();
  h.event({ type:'hello',chats:[{id:'general',kind:'chat',title:'General'}],pending:0,features:{quoted_comments:true} });
  await h.tick();
  const sent:any[]=[];h.setRequest(echoServer(sent));
  const quote={v:1,message_id:'source',chat_id:'general',start:10,end:15,text:'quote',source_hash:'a'.repeat(64)};
  await h.store.getState().sendMessage('s','general','Explain',{replyTo:{id:'source',role:'bot',text:'quote',quote}});
  assert.equal(sent.length,1);assert.equal(sent[0].reply_to,'source');
  assert.deepEqual(sent[0].quote,quote);
  assert.equal(sent[0].text,'Explain');
});
test('an old server cannot silently turn a quoted send into a whole-reply send', async () => {
  const h=harness();await h.connect();await h.hello();
  const sent:any[]=[];h.setRequest(echoServer(sent));
  const quote={v:1,message_id:'source',chat_id:'general',start:0,end:5,text:'quote',source_hash:'a'.repeat(64)};
  await h.store.getState().sendMessage('s','general','Explain',{replyTo:{id:'source',role:'bot',text:'quote',quote}});
  assert.equal(sent.length,0);assert.equal(h.outbox()[0].failed,true);
  assert.match(h.messages()[0].meta.delivery_error,/does not support exact quotes/);
  assert.equal(h.outbox()[0].reply_to.quote.text,'quote');
});
test('an offline quote retains its exact anchor through outbox persistence and reconnect', async () => {
  const h=harness();await h.connect();
  const quote={v:1,message_id:'source',chat_id:'general',start:2,end:4,text:'🌱',source_hash:'b'.repeat(64)};
  await h.store.getState().sendMessage('s','general','Explain',{replyTo:{id:'source',role:'bot',text:'🌱',quote}});
  assert.equal(h.cache.get('outbox:s')[0].reply_to.quote.text,'🌱');
  const sent:any[]=[];h.setRequest(echoServer(sent));
  h.event({type:'hello',chats:[{id:'general',kind:'chat',title:'General'}],pending:0,features:{quoted_comments:true}});
  await h.tick();await h.tick();
  assert.equal(sent.length,1);assert.deepEqual(sent[0].quote,quote);
});
