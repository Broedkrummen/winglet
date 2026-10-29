import type { Value } from '../sync/model';
export type BookmarkSource = { server_id: string; server_fingerprint: string; chat_id: string; message_id: string };
export type Bookmark = { source: BookmarkSource; title: string; note: string; tags: string[]; removed: boolean; snapshot?: { id: string; sha256: string } };
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x1f]/.test(value);
export function bookmarkFrom(values: Record<string, Value>): Bookmark | undefined {
  const read = (field: string): any => values[field] && !values[field].deleted ? values[field].value : undefined;
  const source = read('source');
  if (!source || Object.keys(source).sort().join() !== 'chat_id,message_id,server_fingerprint,server_id'
    || !Object.values(source).every(identifier)) return;
  const title = read('title') ?? 'Saved answer', note = read('note') ?? '', tags = read('tags') ?? [], removed = read('removed') ?? false;
  if (typeof title !== 'string' || title.length > 160 || typeof note !== 'string' || note.length > 8000 || typeof removed !== 'boolean'
    || !Array.isArray(tags) || tags.length > 20 || tags.some(tag => typeof tag !== 'string' || !tag.length || tag.length > 64)) return;
  const snapshot = read('snapshot');
  if (snapshot && (!identifier(snapshot.id) || !/^[a-f0-9]{64}$/.test(snapshot.sha256)
    || Object.keys(snapshot).sort().join() !== 'id,sha256')) return;
  return { source: { ...source }, title, note, tags: [...tags], removed, ...(snapshot ? { snapshot: { ...snapshot } } : {}) };
}
export const bookmarkField = (value: any): Value => ({ deleted: false, value });
export const bookmarkMatches = (bookmark: Bookmark, query: string) => query.trim().toLocaleLowerCase().split(/\s+/)
  .every(word => `${bookmark.title} ${bookmark.note} ${bookmark.tags.join(' ')}`.toLocaleLowerCase().includes(word));
