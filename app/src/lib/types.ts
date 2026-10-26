export type Bot = { name: string; title: string; description: string };

/** Structured task activity lives in its own feature module; re-exported here for the store and screens. */
export type { TaskCapabilities, TaskEnvelope, TaskSnapshot, TaskState } from '../features/execution/model';

export type Server = {
  id: string; // server_id reported by the plugin
  url: string; // base URL, no trailing slash
  token: string;
  deviceId: string;
  bot: Bot;
  addedAt: number;
  // `since`: ntfy time of the last verified announcement, so later lookups only fetch newer ones.
  recovery?: { server: string; topic: string; key: string; revision: number; since?: number };
  /** The server key's fingerprint, pinned at pairing (from the QR code when there was one). */
  fingerprint?: string;
  /** The server takes the token in the socket's first frame, not the URL. */
  wsAuth?: boolean;
  /** Another bot on the same server (a Hermes profile it serves): its name there, and the main bot's id.
   * It shares the main bot's address, token and pairing; its own id is `<parent>~<profile>`. */
  profile?: string;
  parent?: string;
};

/** A bot on a server, as the server lists it. `served`: Hermes is running it now. */
export type BotRow = { name: string; title: string; description: string; served?: boolean };

export type Role = 'owner' | 'member';

/** Who this phone is on a server: its role, whether it can sign owner actions, and its main chat. */
export type Me = { id: string; name: string; role: Role; verified: boolean; home_chat: string };

export type Device = { id: string; name: string; platform: string; role: Role; verified: boolean;
  created_at: number; last_seen: number; current?: boolean };

export type AuditEntry = { id: number; ts: number; device_id: string; device_name: string; role: string; action: string;
  summary: string; outcome: string };

/** Where a branch chat came from: a snapshot of the parent at the moment it was copied. */
export type ChatBranch = {
  parent_chat_id: string;
  parent_title: string;
  from_message_id: string;
  mode: 'edit' | 'branch' | 'regenerate' | string;
  created_at: number;
  source_revision: string;
};

export type Chat = {
  id: string;
  title: string;
  kind: 'chat' | 'home';
  created_at: number;
  updated_at: number;
  preview: string;
  /** A member's own chat; owners' shared chats have none. */
  owner_device?: string | null;
  /** Present when this chat was branched from another one. */
  branch?: ChatBranch | null;
};

/** One message's branching/editing gates, from the server's real transcript mapping. */
export type BranchMessageCapability = {
  role: 'user' | 'bot';
  can_branch?: boolean;
  can_edit?: boolean;
  can_regenerate?: boolean;
  reason?: string;
};

/** The branching state of one chat, plus the per-message gates for its More menu. */
export type BranchState = {
  supported: boolean;
  reason?: string;
  chat_id?: string;
  revision?: string;
  busy?: boolean;
  model?: { model?: string; provider?: string; label?: string; source?: string } | null;
  branch?: ChatBranch | null;
  children?: { id: string; title: string; created_at: number }[];
  messages?: Record<string, BranchMessageCapability>;
};

/** What the server returns after creating a branch (or replaying an idempotent request). */
export type BranchResult = {
  chat: Chat;
  branch: ChatBranch;
  mode: 'edit' | 'branch' | 'regenerate';
  copies: number;
  later: number;
  revision: string;
  model?: { model?: string; provider?: string; label?: string } | null;
  message?: Message | null;
  warning?: string;
  replayed?: boolean;
};

/** A server-persisted folder of conversations on one bot. `private` projects belong to one member. */
export type Project = {
  id: string;
  name: string;
  /** Stable order within its scope; sorted by the server. */
  position: number;
  archived: boolean;
  /** Rename/archive/reorder/delete are guarded by this revision. */
  revision: number;
  private: boolean;
  /** This device may rename, archive, reorder or delete it. */
  can_manage: boolean;
  /** Chats in the project that this device may see. */
  chat_count: number;
  created_at: number;
  updated_at: number;
};

/** A chat's place in a project. The chat itself (messages, draft, pin) is unchanged. */
export type ProjectThread = { chat_id: string; project_id: string; position: number };

/** Everything the server shares about one bot's projects with this device. */
export type ProjectSnapshot = {
  projects: Project[];
  threads: ProjectThread[];
  /** Changes when a project is created, deleted or reordered in this device's scope. */
  layout_revision: number;
};

export type AttachmentKind = 'image' | 'audio' | 'video' | 'file' | 'voice';

export type Attachment = { url: string; name: string; mime: string; kind: AttachmentKind; size: number; id?: string };

/** A file the server holds for this chat, ready to attach to a message. */
export type Upload = Attachment & { id: string };

/** The message being replied to, as the app shows it above yours. */
export type ReplyRef = { id: string; role: 'user' | 'bot' | 'system'; text: string; quote?: import('../features/transcript-tools/model').QuoteAnchor };

export type Message = {
  id: string;
  position?: number; // server insertion order; absent on optimistic rows and older servers
  chat_id: string;
  role: 'user' | 'bot' | 'system';
  text: string;
  // pending: sending now; queued: waiting for a connection; failed: the server refused it.
  status: 'final' | 'streaming' | 'pending' | 'queued' | 'failed';
  meta: {
    device?: string;
    client_id?: string;
    inbox_id?: string;
    kind?: 'approval' | 'question';
    attachments?: Attachment[];
    reply_to?: ReplyRef;
    /** Set on Hermes status lines (context pressure, fallback…) that update in place. */
    status_key?: string;
    /** A command the app sent for a control (/model and /reasoning from the model sheet); not shown in the chat. */
    hidden?: boolean;
    /** Internal controls and progress stay silent, including after edits. */
    notify?: boolean;
    /** A choice the agent offers: a model, a setting, or a command to confirm. */
    picker?: Picker;
    /** The routine (scheduled job) whose result this is. */
    routine?: string;
    routine_id?: string; run_id?: string;
    /** Set by the server on Hermes's own progress (a tool running), which the chat folds away. */
    activity?: boolean;
    /** A local delivery error; never sent to Hermes as part of the prompt. */
    delivery_error?: string;
  };
  created_at: number;
  updated_at: number;
};

export type InboxItem = {
  id: string;
  kind: 'approval' | 'question' | 'result';
  chat_id: string;
  title: string;
  body: string;
  payload: {
    command?: string;
    description?: string;
    choices?: string[];
    labels?: Record<string, string>;
    styles?: Record<string, string>;
    question?: string;
    multi_select?: boolean;
    message_id?: string;
    job_id?: string; routine_id?: string; run_id?: string;
  };
  status: 'pending' | 'resolved' | 'expired';
  resolution: string;
  created_at: number;
  updated_at: number;
};

export type ConnStatus = 'connecting' | 'online' | 'offline' | 'unauthorized';

/** How far this phone has caught up with a bot's event journal. */
export type SyncPhase = 'unsupported' | 'idle' | 'catching-up' | 'snapshot' | 'blocked';

export type SyncState = {
  phase: SyncPhase;
  /** Events applied during this catch-up, for the "Catching up · n" chip. */
  caught: number;
  /** Why a catch-up couldn't be proved: the server's refusal, or that the snapshot didn't arrive. */
  reason?: 'epoch' | 'cursor' | 'gap' | 'journal' | 'network';
};

/** What a server reports about itself in `hello` and `/api/info`. */
export type ServerInfo = {
  version: string;
  protocol: number;
  min_app_protocol: number;
  hermes_version: string;
  features: Record<string, boolean>;
};

/** A file attached in the composer: uploading, ready to send, or failed. */
export type DraftFile = {
  localId: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  size?: number;
  /** A local preview (photos), shown until the message is sent. */
  previewUri?: string;
  progress: number;
  status: 'uploading' | 'ready' | 'failed';
  upload?: Upload;
  error?: string;
  /** Voice notes send themselves as soon as they finish uploading. */
  autoSend?: boolean;
};

/** A card in the chat that the owner taps to answer: Hermes's /model, /reasoning, /fast and confirmations. */
export type Picker = {
  id: string;
  kind: 'model' | 'choice' | 'confirm';
  status: 'open' | 'done' | 'expired';
  expires_at: number;
  current_model?: string;
  current_provider?: string;
  current_label?: string;
  providers?: { slug: string; name: string; models: string[]; custom_models?: boolean }[];
  choices?: { value: string; label: string; current?: boolean }[];
  detail?: string;
  selected?: string;
  by?: string;
};

/** The model new chats use, and the one a chat really uses when Hermes knows. */
export type AgentInfo = {
  configured: { model: string; provider: string; reasoning_effort: string; label: string };
  chat: { model: string; provider: string; source: 'chat' | 'last_turn' } | null;
};

/** New work is on hold (Hermes's /pause). Members get no reason. */
export type PauseState = { reason: string | null; engaged_at: string | null } | null;

/** A restart, update or install, which may outlive the server process that started it. */
export type Job = {
  id: string;
  kind: 'restart' | 'hermes_update' | 'winglet_update' | 'skill_install' | 'skill_uninstall' | 'mcp_install' | 'pet_install';
  state: 'running' | 'succeeded' | 'failed' | 'unknown';
  device_id: string;
  detail: {
    message?: string; lines?: string[]; command?: string; from?: string; to?: string; finished_at?: number;
    skill?: string; server?: string; pet?: string;
  };
  created_at: number;
  updated_at: number;
};

export type SystemInfo = {
  version: string;
  hermes_version: string;
  uptime_seconds: number;
  host: {
    system?: string; arch?: string; cpu_count?: number; cpu_percent?: number; uptime_seconds?: number; load_avg?: number[];
    memory?: { total: number; used: number; percent: number }; disk?: { total: number; used: number; percent: number };
  };
  paused: PauseState;
  can_pause: boolean;
  connection: { mode: string; url: string | null };
  devices: number;
  jobs: Job[];
};

export type UpdatesInfo = {
  hermes: { install_method?: string; current_version?: string; behind?: number | null; update_available?: boolean;
    can_apply?: boolean; update_command?: string; message?: string | null; error?: string };
  winglet: { update_available: boolean | null; current?: string | null; latest?: string | null; reason?: string;
    needs_fixing?: string | null; version: string };
  checked_at: number;
};

/** A scheduled routine: Hermes runs the prompt on its schedule and posts the result to Updates. */
export type Routine = {
  id: string;
  name: string | null;
  prompt: string;
  schedule_display: string | null;
  state: 'scheduled' | 'paused' | 'running' | 'completed' | 'disabled' | string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  deliver: string | null;
  kind: string | null;
  paused_reason: string | null;
};

/** A standing goal (/goal) a chat's session works toward, turn after turn, until a judge says done. */
export type Goal = {
  goal: string;
  status: 'active' | 'paused' | 'done' | string;
  turns_used: number;
  max_turns: number;
  subgoals: string[];
  last_verdict: string | null;
  last_reason: string | null;
  paused_reason: string | null;
  waiting_reason: string | null;
  created_at: number;
  last_turn_at: number;
};

export type GoalEntry = { chat_id: string; title: string; goal: Goal };

export type SearchResult = {
  message: { id: string; chat_id: string; role: 'user' | 'bot'; created_at: number; position: number };
  chat: { id: string; title: string; kind: 'chat' | 'home' };
  snippet: string;
};

/** A file or photo shared in a chat, with the message it came in. */
export type ChatFile = Attachment & { message_id: string; role: 'user' | 'bot'; created_at: number };

/** An installed skill. provenance: shipped with Hermes, installed from a hub, or written by the agent or you. */
export type Skill = {
  name: string;
  description: string;
  category: string | null;
  enabled: boolean;
  provenance: 'bundled' | 'hub' | 'agent';
  usage: number;
};

/** One of Hermes's official optional skills. */
export type CatalogSkill = { name: string; description: string; identifier: string; category: string; tags: string[]; installed: boolean };

/** A group of tools the agent can use when it works through Winglet. */
export type Toolset = { name: string; label: string; description: string; enabled: boolean; configured: boolean };

export type ApprovalMode = 'manual' | 'smart' | 'off';

/** What members' turns may use. Not limited means the same as an owner. */
export type MemberTools = { limited: boolean; toolsets: string[]; mcp: boolean };

/** can_limit: this Hermes lets Winglet cap every turn's tools, which limits need. */
export type ToolsInfo = { toolsets: Toolset[]; approvals: ApprovalMode; members: MemberTools & { can_limit?: boolean } };

export type McpServer = {
  name: string;
  transport: 'http' | 'stdio' | 'unknown';
  url: string | null;
  command: string | null;
  auth: string | null;
  enabled: boolean;
  source: 'config' | 'plugin';
  plugin: string | null;
};

export type McpInfo = { servers: McpServer[]; needs_reload: boolean; can_reload: boolean };

/** A server in Hermes's approved MCP catalog, with what it runs or connects to. */
export type McpCatalogEntry = {
  name: string;
  description: string;
  transport: string;
  auth_type: string;
  required_env: { name: string; prompt: string; required: boolean }[];
  command: string | null;
  args: string[];
  url: string | null;
  install_url: string | null;
  needs_install: boolean;
  post_install: string;
  installed: boolean;
  enabled: boolean;
};

export type McpSignIn = {
  id: string;
  server: string;
  status: 'starting' | 'authorization_required' | 'approved' | 'error';
  authorization_url: string | null;
  error: string | null;
  tools: string[];
};

export type McpTest = { ok: boolean; error: string | null; tools: { name: string; description: string }[] };

/** The latest delivery to one of this device's subscriptions, since the server started. */
export type Delivery = { at: number; ok: boolean };

/** How a server is reached, and whether this device's notifications and address recovery work. */
export type ConnectionStatus = {
  mode: 'quick' | 'direct';
  /** The address the server gives phones: the tunnel's, or the one set for a direct connection. */
  url: string | null;
  address_since: number | null;
  address_changes: number | null;
  tunnel: { state: 'starting' | 'ready' | 'retrying'; since: number; error: string | null; retry_at: number | null } | null;
  recovery: { enrolled: boolean; last: Delivery | null } | null;
  push: { encrypted?: number; ntfy: number; webpush: number; last: Delivery | null; ntfy_server: string };
  /** Owners only. */
  listen?: string;
  web_keys?: boolean;
};

/** One of Hermes's conversations, from any app or routine. Times are server seconds. */
export type SessionRow = {
  id: string; title: string | null; source: string; model: string; started_at: number | null; last_active: number | null;
  message_count: number; tool_call_count: number; preview: string; active: boolean; pinned: boolean;
  /** Search results only: the words around the match, marked >>>like this<<<. */
  snippet?: string; role?: string | null;
};

export type SessionMessage = {
  id: string; role: 'user' | 'assistant' | 'tool'; text: string; at: number | null; failed: boolean;
  /** Tools an assistant turn called, or the tool a result came from. */
  tools?: string[]; tool?: string;
};

export type SessionTranscript = { session: SessionRow; messages: SessionMessage[]; truncated: boolean };


/** A pet's spritesheet and how to cut it into frames: one row per animation, `frames` real frames in each. */
export type PetSheet = {
  slug: string; name: string; revision: string; mime: string;
  frame_w: number; frame_h: number; columns: number; rows: number;
  /** Row names top to bottom: Hermes's (idle, wave, run…) on older sheets, petdex's (waving, running…) on newer. */
  state_rows: string[];
  frames_per_state: number;
  /** Real frames per state, when the server could count them; a missing state uses frames_per_state. */
  frames: Partial<Record<string, number>>;
  loop_ms: number;
  sheet_url: string; thumb_url: string;
  /** The pet's own colours from its idle frame (newer servers): base for glows, soft/deep for the disc behind it. */
  palette?: PetPalette;
};

export type PetPalette = { base: string; soft: string; deep: string };

export type InstalledPet = { slug: string; name: string; description: string; generated: boolean; thumb_url: string };

export type PetList = { enabled: boolean; active: string; pets: InstalledPet[] };

/** A pet in the petdex gallery. */
export type CatalogPet = { slug: string; name: string; kind: string; by: string; curated: boolean; installed: boolean; thumb_url: string };
