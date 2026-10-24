import type { Chat, Project, ProjectSnapshot, ProjectThread } from '../../lib/types';

/**
 * Projects organize chats; they are not chats or Hermes sessions. A Winglet chat is the persistent
 * thread (its name, draft, pins and messages survive restarts and `/new`), while Hermes owns the
 * execution session inside it. Nothing here changes a chat's identity or access.
 */

export const EMPTY_PROJECTS: ProjectSnapshot = { projects: [], threads: [], layout_revision: 1 };

/** Accept only the shape this client understands; unknown older-server payloads become empty. */
export function readSnapshot(value: unknown): ProjectSnapshot {
  const raw = (value ?? {}) as Partial<ProjectSnapshot>;
  const projects = Array.isArray(raw.projects)
    ? raw.projects.filter((p): p is Project => !!p && typeof p.id === 'string' && typeof p.name === 'string'
      && Number.isFinite(p.revision)).map((p) => ({ ...p, position: Number(p.position) || 0,
        archived: !!p.archived, private: !!p.private, can_manage: !!p.can_manage, chat_count: Number(p.chat_count) || 0 }))
    : [];
  const ids = new Set(projects.map((p) => p.id));
  const threads = Array.isArray(raw.threads)
    ? raw.threads.filter((t): t is ProjectThread => !!t && typeof t.chat_id === 'string' && ids.has(t.project_id))
      .map((t) => ({ chat_id: t.chat_id, project_id: t.project_id, position: Number(t.position) || 0 }))
    : [];
  return { projects, threads, layout_revision: Math.max(1, Number(raw.layout_revision) || 1) };
}

/** The project each chat is in. A chat belongs to at most one project. */
export function projectIndex(snapshot?: ProjectSnapshot): Map<string, Project> {
  const projects = new Map((snapshot?.projects ?? []).map((p) => [p.id, p]));
  const out = new Map<string, Project>();
  for (const thread of snapshot?.threads ?? []) {
    const project = projects.get(thread.project_id);
    if (project && !out.has(thread.chat_id)) out.set(thread.chat_id, project);
  }
  return out;
}

export function projectOf(snapshot: ProjectSnapshot | undefined, chatId: string): Project | undefined {
  return projectIndex(snapshot).get(chatId);
}

export function isInProject(snapshot: ProjectSnapshot | undefined, chatId: string): boolean {
  return projectIndex(snapshot).has(chatId);
}

/** Projects in the snapshot's server order. Archived ones are separate, never mixed in by accident. */
export function splitProjects(snapshot?: ProjectSnapshot): { active: Project[]; archived: Project[] } {
  const active: Project[] = [];
  const archived: Project[] = [];
  for (const project of snapshot?.projects ?? []) (project.archived ? archived : active).push(project);
  return { active, archived };
}

/** Chats in a project, in the project's stable order, newest first when positions tie. */
export function projectChats(snapshot: ProjectSnapshot | undefined, projectId: string,
  chats: Record<string, Chat> | undefined): Chat[] {
  const order = new Map((snapshot?.threads ?? []).filter((t) => t.project_id === projectId)
    .map((t) => [t.chat_id, t.position]));
  return [...order.keys()].map((id) => chats?.[id]).filter((c): c is Chat => !!c)
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
      || b.updated_at - a.updated_at || a.id.localeCompare(b.id));
}

/** Chat ids in a project. Used to keep search scoped to the same set the screen shows. */
export function projectChatIds(snapshot: ProjectSnapshot | undefined, projectId: string): Set<string> {
  return new Set((snapshot?.threads ?? []).filter((t) => t.project_id === projectId).map((t) => t.chat_id));
}

/** The project order after moving one project up (-1) or down (+1), or null at an end. */
export function movedOrder(ids: string[], id: string, direction: -1 | 1): string[] | null {
  const from = ids.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  const next = ids.slice();
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** Apply a new order locally for immediate feedback; positions stay deterministic if it is rolled back. */
export function applyOrder(snapshot: ProjectSnapshot, ids: string[]): ProjectSnapshot {
  const rank = new Map(ids.map((id, index) => [id, (index + 1) * 1000]));
  return { ...snapshot, projects: snapshot.projects.map((p) => rank.has(p.id) ? { ...p, position: rank.get(p.id)! } : p)
    .sort((a, b) => Number(!!a.private) - Number(!!b.private) || a.position - b.position || a.id.localeCompare(b.id)) };
}

/** Projects this device may reorder: shared ones for owners, the member's own private ones otherwise. */
export function reorderableIds(snapshot: ProjectSnapshot | undefined, owner: boolean): string[] {
  return (snapshot?.projects ?? []).filter((p) => p.can_manage && p.private !== owner)
    .map((p) => p.id);
}

/** Does a chat match a project search, including its draft and preview? */
export function matchesProjectSearch(chat: Chat, query: string, draft?: string | null): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${chat.title} ${chat.preview ?? ''} ${draft ?? ''}`.toLowerCase().includes(q);
}

/** A title safe to show in a sheet or header when the server has not sent the project yet. */
export function projectTitle(project?: Project): string {
  return project?.name?.trim() || 'Project';
}

/** One line for a project row: how many chats this device can see. */
export function projectCountLabel(project: Project): string {
  const n = project.chat_count;
  return `${n} ${n === 1 ? 'chat' : 'chats'}`;
}
