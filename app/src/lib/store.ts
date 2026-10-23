import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { Platform } from 'react-native';
import { RecoveryCoordinator } from './recovery';
import { sound } from './sounds';
import { api, ApiError, wsUrl } from './api';
import { cacheGet, cacheRemove, cacheSet } from './cache';
import { isNotifiable, markFailed, mergeMessages } from './messages';
import { getJSON, setJSON } from './storage';
import { NEEDS_VERIFY } from './verify';
import type { Attachment, BotRow, Chat, ConnStatus, DraftFile, InboxItem, Job, Me, Message, PauseState, PetSheet, ReplyRef, Server, ServerInfo } from './types';

const SERVERS_KEY = 'winglet.servers';
const SELECTION_KEY = 'winglet.selection';
const TYPING_TTL_MS = 8000;
const HISTORY_LIMIT = 30;
/** The wire protocol this app speaks, and the oldest server protocol it still works with. */
export const APP_PROTOCOL = 1;
/** Server fields a server's other bots share with it. */
const SHARED_FIELDS = new Set(['url', 'token', 'deviceId', 'fingerprint', 'wsAuth']);
export const MIN_SERVER_PROTOCOL = 1;

export type Toast = { id: string; serverId: string; title: string; body: string; href?: string };

/** What the Connection screen shows; never contains tokens, URLs or message text. */
export type ConnDetail = {
  recovering: boolean;
  nextRetryAt?: number;
  lastError?: string;
  history: { t: number; status: string; note?: string }[];
};

export type OutboxEntry = {
  client_id: string; chat_id: string; text: string; created_at: number; failed?: boolean;
  failure?: string;
  attachments?: Attachment[]; reply_to?: ReplyRef;
};

export type SendOptions = { retryClientId?: string; attachments?: Attachment[]; replyTo?: ReplyRef };

export type ServerState = {
  status: ConnStatus;
  conn: ConnDetail;
  info?: ServerInfo;
  compat?: 'update-app' | 'update-server';
  chats: Record<string, Chat>;
  messages: Record<string, Message[]>;
  deleted: Record<string, string[]>;
  loaded: Record<string, boolean>;
  inbox: Record<string, InboxItem>;
  pending: number;
  typing: Record<string, number>;
  outbox: OutboxEntry[];
  /** When the agent last finished a reply, for a moment of celebration on its face. */
  lastReplyAt?: number;
  /** This phone's role and main chat on the server (from hello). */
  me?: Me;
  /** New work is on hold on this server. */
  paused?: PauseState;
  /** The latest restart or update this phone heard about. */
  job?: Job;
  /** The agent's pet, its animated face: null when it has none, undefined until known. */
  pet?: PetSheet | null;
};

type Selection = { serverId?: string; chatId?: string };

type AppState = {
  ready: boolean;
  servers: Server[];
  runtime: Record<string, ServerState>;
  selection: Selection;
  toasts: Toast[];
  foreground: boolean;
  network: boolean;
  drafts: Record<string, string>;
  /** Files attached in each chat's composer, by draftKey. */
  draftFiles: Record<string, DraftFile[]>;
  /** The message each chat's composer is replying to, by draftKey. */
  replyTo: Record<string, ReplyRef>;
  visibleChat?: { serverId: string; chatId: string };
  init: () => Promise<void>;
  addServer: (server: Server) => Promise<void>;
  /** Change a saved server (a verified key, a new token); `reconnect` opens a fresh socket with it. */
  updateServer: (serverId: string, change: Partial<Server>, reconnect?: boolean) => Promise<void>;
  removeServer: (serverId: string, unpair?: boolean) => Promise<void>;
  select: (serverId?: string, chatId?: string) => void;
  setVisibleChat: (v?: { serverId: string; chatId: string }) => void;
  setForeground: (fg: boolean) => void;
  setNetwork: (online: boolean) => void;
  retryNow: (serverId: string) => void;
  hydrateChat: (serverId: string, chatId: string) => Promise<void>;
  /** Resolves false when the page couldn't be fetched (offline, a server error). */
  loadMessages: (serverId: string, chatId: string, older?: boolean) => Promise<boolean>;
  loadInbox: (serverId: string) => Promise<void>;
  loadPet: (serverId: string) => Promise<void>;
  /** Match a server's other bots to the list it sent: add new ones, drop removed ones, keep names current. */
  syncBots: (serverId: string, bots: BotRow[]) => Promise<void>;
  sendMessage: (serverId: string, chatId: string, text: string, opts?: string | SendOptions) => Promise<void>;
  updateDraftFiles: (serverId: string, chatId: string, fn: (files: DraftFile[]) => DraftFile[]) => void;
  setReplyTo: (serverId: string, chatId: string, ref?: ReplyRef) => void;
  discardMessage: (serverId: string, chatId: string, clientId: string) => void;
  setDraft: (serverId: string, chatId: string, text: string) => void;
  respond: (serverId: string, itemId: string, reply: { choice?: string; answer?: string | string[] }) => Promise<void>;
  createChat: (serverId: string, title?: string) => Promise<Chat | undefined>;
  renameChat: (serverId: string, chatId: string, title: string) => Promise<void>;
  deleteChat: (serverId: string, chatId: string) => Promise<void>;
  toast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
  clearCache: () => Promise<void>;
};

export const emptyRuntime = (): ServerState => ({
  status: 'connecting', conn: { recovering: false, history: [] }, chats: {}, messages: {}, deleted: {}, loaded: {},
  inbox: {}, pending: 0, typing: {}, outbox: [],
});

export const draftKey = (serverId: string, chatId: string) => `${serverId}:${chatId}`;

/** This phone's main chat with a bot: the shared one for owners, a member's own one otherwise. */
export const homeChat = (rt?: ServerState) => rt?.me?.home_chat ?? 'general';

/** Owners can approve commands and manage the server; members chat in their own chats. */
export const isOwner = (rt?: ServerState) => (rt?.me?.role ?? 'owner') === 'owner';

const connections = new Map<string, Connection>();
const coordinator = new RecoveryCoordinator();
/** Per-bot send queue: keeps messages in order, and stops at the first one the network loses. */
const sendChains = new Map<string, Promise<void>>();
const sendPaused = new Set<string>();

/** A network failure is worth retrying later; an HTTP error from the server is not. */
const isNetworkError = (e: unknown) => !(e instanceof ApiError) || e.status === 0;

const isLocal = (m: Message) => m.status === 'pending' || m.status === 'queued' || m.status === 'failed';

export const useApp = create<AppState>((set, get) => {
  const patch = (serverId: string, fn: (s: ServerState) => Partial<ServerState>) =>
    set((state) => {
      if (!state.servers.some((server) => server.id === serverId)) return state;
      const current = state.runtime[serverId] ?? emptyRuntime();
      return { runtime: { ...state.runtime, [serverId]: { ...current, ...fn(current) } } };
    });

  const upsertMessage = (serverId: string, chatId: string, message: Message) =>
    patch(serverId, (s) => {
      if (s.deleted[chatId]?.includes(message.id)) return {};
      const list = s.messages[chatId] ?? [];
      const clientId = message.meta?.client_id;
      const idx = list.findIndex((m) => m.id === message.id || (clientId && m.meta?.client_id === clientId));
      const have = idx >= 0 ? list[idx] : undefined;
      // A streamed edit to a message already in place: swap that one row, no re-sort of the chat.
      if (have && have.id === message.id && !isLocal(have) && !isLocal(message)
        && (message.position ?? have.position) === have.position) {
        if (message.updated_at < have.updated_at) return {};
        const next = list.slice();
        next[idx] = message.position === have.position ? message : { ...message, position: have.position };
        return { messages: { ...s.messages, [chatId]: next } };
      }
      const next = idx >= 0 ? list.map((m, i) => (i === idx ? message : m)) : [...list, message];
      return { messages: { ...s.messages, [chatId]: mergeMessages(next, []) } };
    });

  const setLocalStatus = (serverId: string, chatId: string, clientId: string, status: Message['status']) =>
    patch(serverId, (s) => ({
      messages: { ...s.messages, [chatId]: (s.messages[chatId] ?? []).map((m) =>
        m.id === clientId && isLocal(m) ? { ...m, status } : m) },
    }));

  const saveOutbox = (serverId: string) => cacheSet(`outbox:${serverId}`, get().runtime[serverId]?.outbox ?? []);

  const updateOutbox = (serverId: string, fn: (o: OutboxEntry[]) => OutboxEntry[]) => {
    patch(serverId, (s) => ({ outbox: fn(s.outbox) }));
    saveOutbox(serverId);
  };

  const toast = (t: Omit<Toast, 'id'>) => {
    if (t.body === NEEDS_VERIFY) return; // the Verify this phone sheet is already explaining it
    const id = Math.random().toString(36).slice(2);
    set((state) => ({ toasts: [...state.toasts.slice(-2), { ...t, id }] }));
    setTimeout(() => get().dismissToast(id), 5000);
  };

  const persist = () => setJSON(SERVERS_KEY, get().servers);

  const note = (serverId: string, status: string, extra?: string) =>
    patch(serverId, (s) => {
      const last = s.conn.history[s.conn.history.length - 1];
      if (last && last.status === status && last.note === extra) return {};
      return { conn: { ...s.conn, history: [...s.conn.history.slice(-(HISTORY_LIMIT - 1)), { t: Date.now(), status, note: extra }] } };
    });

  /** Drop everything the app holds for a deleted chat and move off it if it was open. */
  const forgetChat = (serverId: string, chatId: string) => {
    patch(serverId, (s) => {
      const { [chatId]: _chat, ...chats } = s.chats;
      const { [chatId]: _messages, ...messages } = s.messages;
      const { [chatId]: _deleted, ...deleted } = s.deleted;
      const { [chatId]: _loaded, ...loaded } = s.loaded;
      const { [chatId]: _typing, ...typing } = s.typing;
      return { chats, messages, deleted, loaded, typing, outbox: s.outbox.filter((o) => o.chat_id !== chatId) };
    });
    const key = draftKey(serverId, chatId);
    set((state) => {
      const { [key]: _draft, ...drafts } = state.drafts;
      const { [key]: _files, ...draftFiles } = state.draftFiles;
      const { [key]: _reply, ...replyTo } = state.replyTo;
      return { drafts, draftFiles, replyTo };
    });
    saveOutbox(serverId);
    cacheRemove(`msgs:${serverId}:${chatId}`);
    const { selection, select } = get();
    if (selection.serverId === serverId && selection.chatId === chatId) select(serverId, homeChat(get().runtime[serverId]));
  };

  /** Deliver one queued message. Network failures pause the queue (order matters); HTTP errors fail it. */
  const deliver = async (serverId: string, entry: OutboxEntry) => {
    const server = get().servers.find((s) => s.id === serverId);
    const queued = get().runtime[serverId]?.outbox.find((o) => o.client_id === entry.client_id);
    if (!server || !queued || queued.failed) return;
    if (sendPaused.has(serverId) || get().runtime[serverId]?.status !== 'online') {
      sendPaused.add(serverId);
      setLocalStatus(serverId, entry.chat_id, entry.client_id, 'queued');
      return;
    }
    setLocalStatus(serverId, entry.chat_id, entry.client_id, 'pending');
    try {
      const data = await api<{ message: Message }>(server, `/api/chats/${encodeURIComponent(entry.chat_id)}/messages`, {
        method: 'POST', body: JSON.stringify({
          text: entry.text, client_id: entry.client_id,
          ...(entry.attachments?.length ? { attachments: entry.attachments.map((a) => a.id).filter(Boolean) } : {}),
          ...(entry.reply_to ? { reply_to: entry.reply_to.id } : {}),
        }),
      });
      upsertMessage(serverId, entry.chat_id, data.message);
      updateOutbox(serverId, (o) => o.filter((x) => x.client_id !== entry.client_id));
    } catch (e) {
      // A socket acknowledgement may have removed this send while HTTP was still in flight.
      // Its later failure must not pause unrelated messages or put the accepted send back in the outbox.
      if (!get().runtime[serverId]?.outbox.some((o) => o.client_id === entry.client_id)) return;
      if (isNetworkError(e)) {
        // Lost on the way (maybe after the server stored it): resend with the same id later.
        sendPaused.add(serverId);
        setLocalStatus(serverId, entry.chat_id, entry.client_id, 'queued');
        setTimeout(() => { if (get().runtime[serverId]?.status === 'online') flushOutbox(serverId); }, 5000);
      } else {
        const failure = (e as Error).message || 'The server refused this message.';
        updateOutbox(serverId, (o) => o.map((x) => (x.client_id === entry.client_id ? { ...x, failed: true, failure } : x)));
        patch(serverId, (s) => ({ messages: { ...s.messages, [entry.chat_id]: markFailed(s.messages[entry.chat_id] ?? [], entry.client_id, failure) } }));
      }
    }
  };

  const enqueue = (serverId: string, entry: OutboxEntry) => {
    const chain = (sendChains.get(serverId) ?? Promise.resolve()).then(() => deliver(serverId, entry));
    sendChains.set(serverId, chain);
    return chain;
  };

  /** Resend everything still queued for this bot, oldest first. */
  const flushOutbox = (serverId: string) => {
    sendPaused.delete(serverId);
    const entries = [...(get().runtime[serverId]?.outbox ?? [])].filter((o) => !o.failed)
      .sort((a, b) => a.created_at - b.created_at);
    entries.forEach((entry) => enqueue(serverId, entry));
  };

  const localMessage = (entry: OutboxEntry): Message => ({
    id: entry.client_id, chat_id: entry.chat_id, role: 'user', text: entry.text, status: entry.failed ? 'failed' : 'queued',
    meta: { client_id: entry.client_id, ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
      ...(entry.failure ? { delivery_error: entry.failure } : {}),
      ...(entry.reply_to ? { reply_to: entry.reply_to } : {}) },
    created_at: entry.created_at, updated_at: entry.created_at,
  });

  const handleEvent = (serverId: string, ev: any) => {
    const server = get().servers.find((s) => s.id === serverId);
    switch (ev.type) {
      case 'hello': {
        const chats: Record<string, Chat> = {};
        for (const c of ev.chats as Chat[]) chats[c.id] = c;
        const typing: Record<string, number> = {};
        for (const chatId of ev.typing ?? []) typing[chatId] = Date.now() + TYPING_TTL_MS;
        const info: ServerInfo = {
          version: ev.version ?? '', protocol: ev.protocol ?? 1, min_app_protocol: ev.min_app_protocol ?? 1,
          hermes_version: ev.hermes_version ?? '', features: ev.features ?? {},
        };
        const compat = info.min_app_protocol > APP_PROTOCOL ? 'update-app' as const
          : info.protocol < MIN_SERVER_PROTOCOL ? 'update-server' as const : undefined;
        patch(serverId, () => ({ status: 'online', chats, typing, pending: ev.pending ?? 0, loaded: {}, info, compat,
          me: ev.me as Me | undefined, paused: (ev.paused ?? null) as PauseState }));
        // From now on, send the token in the socket's first frame rather than the URL.
        if (server && info.features.ws_auth && !server.wsAuth) get().updateServer(serverId, { wsAuth: true });
        cacheSet(`chats:${serverId}`, chats);
        if (server && ev.bot && JSON.stringify(ev.bot) !== JSON.stringify(server.bot)) {
          set((state) => ({ servers: state.servers.map((s) => (s.id === serverId ? { ...s, bot: ev.bot } : s)) }));
          persist();
        }
        get().loadInbox(serverId);
        get().loadPet(serverId);
        if (Array.isArray(ev.bots) && server && !server.parent) get().syncBots(serverId, ev.bots as BotRow[]);
        // A member can't open the shared main chat: point them at their own (also after a role change).
        const sel = get().selection;
        if (sel.serverId === serverId && sel.chatId && !chats[sel.chatId]) get().select(serverId, homeChat(get().runtime[serverId]));
        const vis = get().visibleChat;
        if (vis?.serverId === serverId) get().loadMessages(serverId, vis.chatId);
        flushOutbox(serverId);
        break;
      }
      case 'message.new':
      case 'message.update': {
        const m = ev.message as Message;
        const before = get().runtime[serverId]?.messages[ev.chat_id]?.find((x) => x.id === m.id);
        upsertMessage(serverId, ev.chat_id, m);
        const clientId = m.meta?.client_id;
        if (m.role === 'user' && clientId && get().runtime[serverId]?.outbox.some((o) => o.client_id === clientId)) {
          // The server has it (the HTTP reply may have been lost): it's no longer ours to resend.
          updateOutbox(serverId, (o) => o.filter((x) => x.client_id !== clientId));
        }
        const vis = get().visibleChat;
        const seeing = get().foreground && vis?.serverId === serverId && vis.chatId === ev.chat_id;
        // A reply ends the bot's turn. Its tool-progress bubbles arrive as final messages too, but it's still
        // working: Hermes only re-sends "typing" a moment later, and the chat shouldn't flicker in between.
        const finished = isNotifiable(m) && (!before || before.status === 'streaming') && (!before || m.updated_at >= before.updated_at);
        if (finished) {
          const wasTyping = !!get().runtime[serverId]?.typing[ev.chat_id];
          patch(serverId, (s) => {
            const typing = { ...s.typing };
            delete typing[ev.chat_id];
            return { typing, lastReplyAt: Date.now() };
          });
          // Once per turn, and only where you can see it land (elsewhere it toasts).
          if (wasTyping && seeing) sound.reply();
        }
        if (finished && !seeing && get().foreground && server) {
          const chat = get().runtime[serverId]?.chats[ev.chat_id];
          toast({ serverId, title: `${server.bot.title}${chat && chat.kind === 'chat' ? ` · ${chat.title}` : ''}`,
            body: m.text.slice(0, 140) || 'Sent an attachment', href: `/chat/${serverId}/${ev.chat_id}` });
        }
        break;
      }
      case 'message.delete':
        patch(serverId, (s) => ({
          messages: { ...s.messages, [ev.chat_id]: (s.messages[ev.chat_id] ?? []).filter((m) => m.id !== ev.message_id) },
          deleted: { ...s.deleted, [ev.chat_id]: [...new Set([...(s.deleted[ev.chat_id] ?? []), ev.message_id])] },
        }));
        break;
      case 'chat.update':
        if (ev.chat) patch(serverId, (s) => ({ chats: { ...s.chats, [ev.chat.id]: ev.chat } }));
        break;
      case 'chat.delete':
        forgetChat(serverId, ev.chat_id);
        break;
      case 'typing':
        patch(serverId, (s) => {
          const typing = { ...s.typing };
          if (ev.on) typing[ev.chat_id] = Date.now() + TYPING_TTL_MS;
          else delete typing[ev.chat_id];
          return { typing };
        });
        break;
      case 'system.paused':
        patch(serverId, () => ({ paused: (ev.paused ?? null) as PauseState }));
        break;
      case 'pet.update':
        get().loadPet(serverId);
        break;
      case 'system.bots':
        if (Array.isArray(ev.bots) && server && !server.parent) get().syncBots(serverId, ev.bots as BotRow[]);
        break;
      case 'system.job':
        if (ev.job) patch(serverId, () => ({ job: ev.job as Job }));
        break;
      case 'inbox.new':
      case 'inbox.update': {
        const item = ev.item as InboxItem;
        patch(serverId, (s) => ({ inbox: { ...s.inbox, [item.id]: item }, pending: ev.pending ?? s.pending }));
        // A member can't answer approvals; the card in their chat already says it's waiting for an owner.
        const actionable = item.kind !== 'result' && (item.kind !== 'approval' || isOwner(get().runtime[serverId]));
        if (ev.type === 'inbox.new' && actionable && item.status === 'pending' && get().foreground && server) {
          if (get().foreground) sound.needsYou();
          toast({ serverId, title: `${server.bot.title} · ${item.title}`, body: item.body.slice(0, 140),
            href: `/inbox?server=${encodeURIComponent(serverId)}&item=${encodeURIComponent(item.id)}` });
        }
        break;
      }
    }
  };

  const connect = (server: Server) => {
    connections.get(server.id)?.close();
    const conn = new Connection(server, coordinator, {
      onEvent: (ev) => handleEvent(server.id, ev),
      onStatus: (status, why) => {
        patch(server.id, () => ({ status }));
        note(server.id, status, why);
        if (status !== 'online') sendPaused.add(server.id);
      },
      onDetail: (detail) => patch(server.id, (s) => ({ conn: { ...s.conn, ...detail } })),
      onRecovering: (on) => {
        patch(server.id, (s) => ({ conn: { ...s.conn, recovering: on } }));
        if (on) note(server.id, 'recovering');
      },
      onServer: async (updated) => {
        if (connections.get(server.id) !== conn || !get().servers.some(s => s.id === server.id)) return;
        set(state => ({ servers: state.servers.map(s => s.id === server.id ? updated : s) }));
        note(server.id, 'address-changed');
        await persist();
        // Its other bots are at the same new address.
        const shared = Object.fromEntries(Object.entries(updated).filter(([k]) => SHARED_FIELDS.has(k)));
        for (const child of get().servers.filter((s) => s.parent === server.id)) await get().updateServer(child.id, shared, true);
      },
    });
    connections.set(server.id, conn);
    conn.open();
  };

  /** The latest pet request per bot. */
  const petLoads = new Map<string, number>();

  /** Load what this phone remembers about a bot, so it opens instantly and works offline. */
  const hydrateServer = async (serverId: string) => {
    const [chats, inbox, outbox, pet] = await Promise.all([
      cacheGet<Record<string, Chat>>(`chats:${serverId}`, {}),
      cacheGet<InboxItem[]>(`inbox:${serverId}`, []),
      cacheGet<OutboxEntry[]>(`outbox:${serverId}`, []),
      cacheGet<PetSheet | null>(`pet:${serverId}`, null),
    ]);
    patch(serverId, (s) => {
      const messages = { ...s.messages };
      for (const entry of outbox) {
        messages[entry.chat_id] = mergeMessages(messages[entry.chat_id] ?? [], [localMessage(entry)]);
      }
      const cachedInbox: Record<string, InboxItem> = {};
      for (const item of inbox) cachedInbox[item.id] = item;
      const live = Object.keys(s.inbox).length > 0;
      return {
        // A live hello may already have arrived; the server's view always wins.
        chats: Object.keys(s.chats).length ? s.chats : chats,
        inbox: live ? s.inbox : cachedInbox,
        pending: live ? s.pending : inbox.filter((i) => i.status === 'pending').length,
        outbox: [...s.outbox, ...outbox.filter((o) => !s.outbox.some((x) => x.client_id === o.client_id))],
        messages,
        pet: s.pet === undefined ? pet : s.pet,
      };
    });
  };

  return {
    ready: false,
    servers: [],
    runtime: {},
    selection: {},
    toasts: [],
    foreground: true,
    network: true,
    drafts: {},
    draftFiles: {},
    replyTo: {},

    init: async () => {
      if (get().ready) return;
      const servers = await getJSON<Server[]>(SERVERS_KEY, []);
      const selection = await getJSON<Selection>(SELECTION_KEY, {});
      const drafts = await cacheGet<Record<string, string>>('drafts', {});
      const draftFiles = await cacheGet<Record<string, DraftFile[]>>('draftFiles', {});
      const replyTo = await cacheGet<Record<string, ReplyRef>>('replyTo', {});
      const runtime: Record<string, ServerState> = {};
      for (const s of servers) runtime[s.id] = emptyRuntime();
      set({ servers, runtime, drafts, draftFiles, replyTo, selection: selection.serverId ? selection : { serverId: servers[0]?.id }, ready: true });
      await Promise.all(servers.map((s) => hydrateServer(s.id)));
      servers.forEach(connect);
    },

    addServer: async (server) => {
      const others = get().servers.filter((s) => s.id !== server.id);
      set((state) => ({
        servers: [...others, server],
        runtime: { ...state.runtime, [server.id]: state.runtime[server.id] ?? emptyRuntime() },
        selection: { serverId: server.id, chatId: 'general' },
      }));
      await persist();
      await setJSON(SELECTION_KEY, get().selection);
      connect(server);
    },

    updateServer: async (serverId, change, reconnect = false) => {
      const current = get().servers.find((s) => s.id === serverId);
      if (!current) return;
      const updated = { ...current, ...change };
      // A server's other bots reach it the same way: they follow its address, token and key.
      const shared = Object.fromEntries(Object.entries(change).filter(([k]) => SHARED_FIELDS.has(k)));
      const children = Object.keys(shared).length ? get().servers.filter((s) => s.parent === serverId) : [];
      const following = children.map((c) => ({ ...c, ...shared }));
      set((state) => ({ servers: state.servers.map((s) => (s.id === serverId ? updated
        : following.find((f) => f.id === s.id) ?? s)) }));
      await persist();
      for (const s of [updated, ...following]) {
        if (reconnect) connect(s);
        else connections.get(s.id)?.setServer(s);
      }
    },

    syncBots: async (serverId, bots) => {
      const main = get().servers.find((s) => s.id === serverId);
      if (!main || main.parent) return;
      const existing = get().servers.filter((s) => s.parent === serverId);
      const wanted = bots.filter((b) => b && typeof b.name === 'string' && b.name);
      for (const old of existing) {
        if (!wanted.some((b) => b.name === old.profile)) await get().removeServer(old.id, false);
      }
      const added: Server[] = [];
      set((state) => {
        let servers = state.servers;
        const runtime = { ...state.runtime };
        for (const b of wanted) {
          const id = `${serverId}~${b.name}`;
          const bot = { name: b.name, title: b.title || b.name, description: b.description || '' };
          const have = servers.find((s) => s.id === id);
          if (have) {
            if (JSON.stringify(have.bot) !== JSON.stringify(bot)) servers = servers.map((s) => (s.id === id ? { ...s, bot } : s));
            continue;
          }
          const child: Server = { id, url: main.url, token: main.token, deviceId: main.deviceId, bot, addedAt: Date.now(),
            fingerprint: main.fingerprint, wsAuth: main.wsAuth, profile: b.name, parent: serverId };
          // Right after its server and that server's other bots, so a server's bots stay together.
          const at = servers.reduce((last, s, i) => (s.id === serverId || s.parent === serverId ? i : last), -1);
          servers = [...servers.slice(0, at + 1), child, ...servers.slice(at + 1)];
          runtime[id] = runtime[id] ?? emptyRuntime();
          added.push(child);
        }
        return { servers, runtime };
      });
      await persist();
      for (const child of added) {
        hydrateServer(child.id);
        connect(child);
      }
    },

    removeServer: async (serverId, unpair = true) => {
      const server = get().servers.find((s) => s.id === serverId);
      // A server's other bots go with it; removing one of them never unpairs the phone from the server.
      for (const child of get().servers.filter((s) => s.parent === serverId)) await get().removeServer(child.id, false);
      if (server?.parent) unpair = false;
      connections.get(serverId)?.close();
      connections.delete(serverId);
      sendChains.delete(serverId);
      sendPaused.delete(serverId);
      if (server && unpair) {
        api(server, '/api/me', { method: 'DELETE' }).catch(() => undefined);
      }
      set((state) => {
        const runtime = { ...state.runtime };
        delete runtime[serverId];
        const servers = state.servers.filter((s) => s.id !== serverId);
        const selection = state.selection.serverId === serverId ? { serverId: servers[0]?.id } : state.selection;
        const drafts = Object.fromEntries(Object.entries(state.drafts).filter(([k]) => !k.startsWith(`${serverId}:`)));
        const draftFiles = Object.fromEntries(Object.entries(state.draftFiles).filter(([k]) => !k.startsWith(`${serverId}:`)));
        const replyTo = Object.fromEntries(Object.entries(state.replyTo).filter(([k]) => !k.startsWith(`${serverId}:`)));
        const visibleChat = state.visibleChat?.serverId === serverId ? undefined : state.visibleChat;
        return { servers, runtime, selection, drafts, draftFiles, replyTo, visibleChat };
      });
      for (const prefix of [`chats:${serverId}`, `inbox:${serverId}`, `outbox:${serverId}`, `msgs:${serverId}:`, `pet:${serverId}`]) cacheRemove(prefix);
      await persist();
      await setJSON(SELECTION_KEY, get().selection);
    },

    select: (serverId, chatId) => {
      set({ selection: { serverId, chatId } });
      setJSON(SELECTION_KEY, { serverId, chatId });
    },

    setVisibleChat: (v) => set({ visibleChat: v }),

    setForeground: (fg) => {
      set({ foreground: fg, ...(!fg ? { toasts: [] } : {}) });
      coordinator.setForeground(fg);
      connections.forEach((c) => c.presence(fg));
      if (fg) connections.forEach((c) => c.ensureOpen());
    },

    setNetwork: (online) => {
      const was = get().network;
      set({ network: online });
      coordinator.setOnline(online);
      // Coming back online is the best moment to try again: don't wait out the backoff.
      if (online && !was) connections.forEach((c) => c.retryNow());
    },

    retryNow: (serverId) => {
      connections.get(serverId)?.retryNow();
      coordinator.retryNow();
    },

    hydrateChat: async (serverId, chatId) => {
      if (get().runtime[serverId]?.loaded[chatId]) return;
      const cached = await cacheGet<Message[]>(`msgs:${serverId}:${chatId}`, []);
      if (!cached.length) return;
      patch(serverId, (s) => {
        // Fresh server data already arrived: it supersedes the cache.
        if (s.loaded[chatId]) return {};
        return { messages: { ...s.messages, [chatId]: mergeMessages(cached, s.messages[chatId] ?? [], s.deleted[chatId] ?? []) } };
      });
    },

    loadMessages: async (serverId, chatId, older = false) => {
      const server = get().servers.find((s) => s.id === serverId);
      if (!server) return false;
      const existing = get().runtime[serverId]?.messages[chatId] ?? [];
      // Page from the oldest message the server knows (optimistic rows have no server position).
      const oldest = existing.find((m) => !isLocal(m));
      const before = older && oldest ? (oldest.position !== undefined
        ? `&before_position=${oldest.position}` : `&before_id=${encodeURIComponent(oldest.id)}`) : '';
      try {
        const data = await api<{ messages: Message[]; deleted_ids?: string[] }>(server, `/api/chats/${encodeURIComponent(chatId)}/messages?limit=60${before}`);
        if (get().servers.find((s) => s.id === serverId) !== server) return false;
        patch(serverId, (s) => {
          if (s.status === 'online' && !s.chats[chatId]) return {};
          // A live delete may have arrived after this snapshot was taken. Keep both sets so a stale
          // response cannot bring it back, and reconnect can apply deletes missed while offline.
          const deleted = [...new Set([...(s.deleted[chatId] ?? []), ...(data.deleted_ids ?? [])])];
          // Rows from the cache or before a reconnect may end before this page starts, if more than a
          // page arrived meanwhile. Unless the page overlaps them (or is the whole chat), drop them and
          // let scrolling page the history in again, rather than show a silent gap.
          const current = s.messages[chatId] ?? [];
          const have = new Set(current.filter((m) => !isLocal(m)).map((m) => m.id));
          const joined = older || s.loaded[chatId] || data.messages.length < 60 || data.messages.some((m) => have.has(m.id));
          const base = joined ? current : current.filter(isLocal);
          return {
            messages: { ...s.messages, [chatId]: mergeMessages(base, data.messages, deleted, older) },
            deleted: { ...s.deleted, [chatId]: deleted },
            loaded: { ...s.loaded, [chatId]: true },
          };
        });
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) patch(serverId, () => ({ status: 'unauthorized' }));
        return false;
      }
    },

    loadPet: async (serverId) => {
      const server = get().servers.find((s) => s.id === serverId);
      if (!server) return;
      const load = (petLoads.get(serverId) ?? 0) + 1;
      petLoads.set(serverId, load);
      let pet: PetSheet | null = null;
      if (get().runtime[serverId]?.info?.features?.pets) {
        try {
          pet = (await api<{ pet: PetSheet | null }>(server, '/api/pet')).pet;
        } catch {
          return; // offline: keep the face we have
        }
      }
      // Answers can arrive out of order: only the latest request's may show, or be remembered.
      if (petLoads.get(serverId) !== load) return;
      patch(serverId, () => ({ pet }));
      cacheSet(`pet:${serverId}`, pet);
    },

    loadInbox: async (serverId) => {
      const server = get().servers.find((s) => s.id === serverId);
      if (!server) return;
      try {
        const data = await api<{ items: InboxItem[]; pending: number }>(server, '/api/inbox');
        const inbox: Record<string, InboxItem> = {};
        for (const item of data.items) inbox[item.id] = item;
        patch(serverId, () => ({ inbox, pending: data.pending }));
      } catch {
        // offline: keep what we have
      }
    },

    sendMessage: async (serverId, chatId, text, opts) => {
      const o: SendOptions = typeof opts === 'string' ? { retryClientId: opts } : opts ?? {};
      const retryClientId = o.retryClientId;
      const server = get().servers.find((s) => s.id === serverId);
      if (!server || (!text.trim() && !o.attachments?.length && !retryClientId)) return;
      if (retryClientId && get().runtime[serverId]?.messages[chatId]?.some((m) =>
        !isLocal(m) && m.meta?.client_id === retryClientId)) return;
      // A retry reuses the original id so the server can tell it already has the message.
      const clientId = retryClientId ?? `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const existing = get().runtime[serverId]?.outbox.find((x) => x.client_id === clientId);
      const entry: OutboxEntry = existing ? { ...existing, failed: false, failure: undefined }
        : { client_id: clientId, chat_id: chatId, text: text.trim(), created_at: Date.now() / 1000,
          ...(o.attachments?.length ? { attachments: o.attachments } : {}), ...(o.replyTo ? { reply_to: o.replyTo } : {}) };
      updateOutbox(serverId, (o) => [...o.filter((x) => x.client_id !== clientId), entry]);
      upsertMessage(serverId, chatId, { ...localMessage(entry), status: get().runtime[serverId]?.status === 'online' ? 'pending' : 'queued' });
      if (retryClientId) sendPaused.delete(serverId);
      await enqueue(serverId, entry);
    },

    discardMessage: (serverId, chatId, clientId) => {
      updateOutbox(serverId, (o) => o.filter((x) => x.client_id !== clientId));
      patch(serverId, (s) => ({
        messages: { ...s.messages, [chatId]: (s.messages[chatId] ?? []).filter((m) => !(m.id === clientId && isLocal(m))) },
      }));
    },

    updateDraftFiles: (serverId, chatId, fn) => {
      const key = draftKey(serverId, chatId);
      set((state) => {
        const next = fn(state.draftFiles[key] ?? []);
        const draftFiles = { ...state.draftFiles };
        if (next.length) draftFiles[key] = next;
        else delete draftFiles[key];
        return { draftFiles };
      });
    },

    setReplyTo: (serverId, chatId, ref) => {
      const key = draftKey(serverId, chatId);
      set((state) => {
        const replyTo = { ...state.replyTo };
        if (ref) replyTo[key] = ref;
        else delete replyTo[key];
        return { replyTo };
      });
    },

    setDraft: (serverId, chatId, text) => {
      const key = draftKey(serverId, chatId);
      if ((get().drafts[key] ?? '') === text) return;
      set((state) => {
        const drafts = { ...state.drafts };
        if (text) drafts[key] = text;
        else delete drafts[key];
        return { drafts };
      });
    },

    respond: async (serverId, itemId, reply) => {
      const server = get().servers.find((s) => s.id === serverId);
      if (!server) return;
      try {
        const data = await api<{ item: InboxItem }>(server, `/api/inbox/${itemId}/respond`, {
          method: 'POST', body: JSON.stringify(reply),
        });
        patch(serverId, (s) => ({ inbox: { ...s.inbox, [itemId]: data.item } }));
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          get().loadInbox(serverId);
          toast({ serverId, title: 'Already answered', body: 'That request expired or was answered on another device.' });
        } else {
          // Never queued: an approval must not fire later, after the moment has passed.
          toast({ serverId, title: "Couldn't send", body: (e as Error).message });
        }
      }
    },

    createChat: async (serverId, title) => {
      const server = get().servers.find((s) => s.id === serverId);
      if (!server) return undefined;
      const data = await api<{ chat: Chat }>(server, '/api/chats', { method: 'POST', body: JSON.stringify({ title }) });
      patch(serverId, (s) => ({ chats: { ...s.chats, [data.chat.id]: data.chat }, loaded: { ...s.loaded, [data.chat.id]: true } }));
      return data.chat;
    },

    renameChat: async (serverId, chatId, title) => {
      const server = get().servers.find((s) => s.id === serverId);
      if (!server) return;
      const data = await api<{ chat: Chat }>(server, `/api/chats/${encodeURIComponent(chatId)}`, {
        method: 'PATCH', body: JSON.stringify({ title }),
      });
      patch(serverId, (s) => ({ chats: { ...s.chats, [chatId]: data.chat } }));
    },

    deleteChat: async (serverId, chatId) => {
      const server = get().servers.find((s) => s.id === serverId);
      if (!server) return;
      await api(server, `/api/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
      forgetChat(serverId, chatId);
    },

    toast,

    dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

    clearCache: async () => {
      for (const prefix of ['msgs:', 'chats:', 'inbox:']) await cacheRemove(prefix);
    },
  };
});

type ConnCallbacks = {
  onEvent: (ev: any) => void;
  onStatus: (s: ConnStatus, why?: string) => void;
  onDetail: (d: Partial<ConnDetail>) => void;
  onRecovering: (on: boolean) => void;
  onServer: (server: Server) => Promise<void>;
};

/** One WebSocket per paired server, with reconnect, backoff and (on Android) address recovery. */
class Connection {
  private ws?: WebSocket;
  private closed = false;
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private pongTimer?: ReturnType<typeof setTimeout>;
  private awaitingPong = false;
  private visible = true;

  constructor(private server: Server, private coordinator: RecoveryCoordinator, private cb: ConnCallbacks) {
    coordinator.join(server.id, {
      server: () => this.server,
      recovering: (on) => cb.onRecovering(on),
      recovered: (updated) => this.adopt(updated),
    });
  }

  private get recovers() {
    return Platform.OS === 'android' && !!this.server.recovery;
  }

  open() {
    if (this.closed) return;
    // A quick tunnel gets a new address when the server restarts: look for one straight away.
    if (this.recovers && this.attempt === 0) this.coordinator.want(this.server.id);
    this.cb.onStatus('connecting');
    this.cb.onDetail({ nextRetryAt: undefined });
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(this.server));
    } catch {
      this.retry('could not open a connection');
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      if (this.server.wsAuth) this.send({ type: 'auth', token: this.server.token });
      this.presence(this.visible);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ type: 'ping', t: Date.now() }), 20000);
    };
    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(String(e.data));
        if (event.type === 'pong') {
          this.awaitingPong = false;
          clearTimeout(this.pongTimer);
        }
        if (event.type === 'hello') {
          this.coordinator.satisfied(this.server.id);
          this.cb.onDetail({ lastError: undefined });
        }
        this.cb.onEvent(event);
        if (event.type === 'hello' && Platform.OS === 'android' && !this.server.recovery) this.enrollRecovery();
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = (e) => {
      clearInterval(this.pingTimer);
      clearTimeout(this.pongTimer);
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (this.closed) return;
      // The server rejects the upgrade with 401 when this device was unpaired.
      if (e.code === 1008 || e.code === 4401) {
        this.cb.onStatus('unauthorized', 'device removed');
        return;
      }
      if (e.code === 4000) {
        // An owner changed this phone's role: reconnect at once to load what it can see now.
        this.cb.onStatus('connecting', 'role changed');
        this.open();
        return;
      }
      this.cb.onStatus('offline');
      this.retry(e.code && e.code !== 1006 ? `closed (${e.code})` : 'connection lost');
    };
    ws.onerror = () => undefined;
  }

  private retry(why: string) {
    clearTimeout(this.timer);
    const cap = this.visible ? 10000 : 30000;
    const delay = Math.min(cap, 1000 * 2 ** this.attempt) * (0.7 + Math.random() * 0.6);
    this.attempt += 1;
    this.cb.onDetail({ lastError: why, nextRetryAt: Date.now() + delay });
    if (this.recovers) this.coordinator.want(this.server.id);
    if (this.attempt > 1) this.probeAuth();
    this.timer = setTimeout(() => this.open(), delay);
  }

  /** Keep this connection's copy of the server current (a new token, a pinned key). */
  setServer(server: Server) {
    this.server = server;
  }

  private async probeAuth() {
    const before = this.server;
    try {
      await api(before, '/api/me');
      // Reachable and paired, yet the socket won't open: an older server that wants the token in the URL.
      if (before.wsAuth) {
        const info = await api<{ protocol?: number }>(before, '/api/info');
        if ((info.protocol ?? 1) < 2 && this.server === before) {
          this.server = { ...before, wsAuth: false };
          await this.cb.onServer(this.server);
        }
      }
    } catch (e) {
      if (this.closed || this.server !== before) return;
      if (e instanceof ApiError && e.status === 401) {
        this.closed = true;
        clearTimeout(this.timer);
        this.cb.onStatus('unauthorized', 'token rejected');
      } else if (this.recovers) {
        this.coordinator.want(this.server.id);
      }
    }
  }

  private async enrollRecovery() {
    try {
      const result = await api<{ recovery: Server['recovery'] }>(this.server, '/api/connection');
      if (this.closed || !result.recovery) return;
      this.server = { ...this.server, recovery: result.recovery };
      await this.cb.onServer(this.server);
    } catch { /* Older or direct-only servers have no recovery endpoint. */ }
  }

  /** Switch to a verified new address and reconnect there at once. */
  private async adopt(updated: Server) {
    if (this.closed) return;
    this.server = updated;
    await this.cb.onServer(updated);
    if (this.closed) return;
    clearTimeout(this.timer);
    const old = this.ws;
    this.ws = undefined;
    old?.close();
    this.attempt = 0;
    this.open();
  }

  /** Back in the foreground: make sure the socket is really alive, not just open on paper. */
  ensureOpen() {
    if (this.closed) return;
    if (!this.ws) {
      this.retryNow();
      return;
    }
    if (this.ws.readyState !== 1) return;
    clearTimeout(this.pongTimer);
    this.awaitingPong = true;
    this.send({ type: 'ping', t: Date.now() });
    const ws = this.ws;
    // A socket the OS silently killed while we were away never answers. Drop it and reconnect.
    this.pongTimer = setTimeout(() => {
      if (!this.awaitingPong || this.ws !== ws || this.closed) return;
      this.awaitingPong = false;
      this.ws = undefined;
      ws.close();
      this.cb.onStatus('offline', 'no answer after resume');
      this.attempt = 0;
      this.retry('no answer after resume');
    }, 4000);
  }

  /** Skip the backoff and try right away (the "Try now" button, or the network coming back). */
  retryNow() {
    if (this.closed || this.ws) return;
    clearTimeout(this.timer);
    this.attempt = 0;
    this.open();
  }

  send(data: unknown) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(data));
  }

  presence(visible: boolean) {
    this.visible = visible;
    this.send({ type: 'presence', visible });
  }

  close() {
    this.closed = true;
    this.coordinator.leave(this.server.id);
    clearTimeout(this.timer);
    clearTimeout(this.pongTimer);
    clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = undefined;
  }
}

const NO_MESSAGES: ServerState['messages'] = {};
const NO_DELETED: ServerState['deleted'] = {};

/**
 * A bot's state without its message lists, for screens that don't show messages: a reply streaming into any
 * chat doesn't re-render them. Everything else (chats, typing, inbox, status) still updates them.
 */
export function useServerState(serverId: string | undefined): ServerState | undefined {
  return useApp(useShallow((st) => {
    const rt = serverId ? st.runtime[serverId] : undefined;
    return rt ? { ...rt, messages: NO_MESSAGES, deleted: NO_DELETED } : undefined;
  }));
}

export function isTyping(state: ServerState | undefined, chatId: string): boolean {
  const until = state?.typing[chatId];
  return !!until && until > Date.now();
}
