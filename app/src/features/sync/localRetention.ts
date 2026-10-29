import { api, encodeApiComponent, signedApi } from '../../lib/api';
import { useLock } from '../../lib/appLock';
import { cacheGetStrict } from '../../lib/cache';
import { useApp } from '../../lib/store';
import type { DraftFile, Server, Upload } from '../../lib/types';
import { beginUploadRetirement } from '../../lib/uploadRetirement';

export type CurrentRetained = { upload: Upload; chat_id: string; source_device: string; hold_id: string; version: string };
type Page = { files: CurrentRetained[]; next: string | null; scope: 'current' };
export class RetainedFileInUse extends Error {}

function check(server: Server) {
  const state = useApp.getState();
  if (!state.ready || !state.foreground || !state.network || useLock.getState().locked || !state.servers.includes(server))
    throw new Error('Reconnect and unlock this paired server before reviewing retained files.');
}

export async function currentRetainedFiles(server: Server, after?: string): Promise<Page> {
  check(server);
  const result = await api<Page>(server, `/api/uploads/retained?scope=current${after ? `&after=${encodeApiComponent(after)}` : ''}`);
  check(server);
  if (result.scope !== 'current' || !Array.isArray(result.files) || result.files.some(file =>
    file.source_device !== server.deviceId || typeof file.version !== 'string' || !file.version))
    throw new Error('Update Winglet on this bot’s server before reviewing this device’s retained files.');
  return result;
}

export function uploadInUse(serverIds: string[], uploadId: string, drafts: Record<string, DraftFile[]>,
  outboxes: Record<string, { attachments?: { id?: string }[] }[]>): boolean {
  return Object.entries(drafts).some(([id, files]) => serverIds.some(serverId => id.startsWith(`${serverId}:`))
    && files.some(file => file.upload?.id === uploadId))
    || serverIds.some(serverId => outboxes[serverId]?.some(entry => entry.attachments?.some(file => file.id === uploadId)));
}

/** Retire one reviewed lease, never all copies sharing a content hash or hold label. */
export async function releaseCurrentRetainedFile(server: Server, file: CurrentRetained) {
  check(server);
  if (file.source_device !== server.deviceId) throw new Error('This file belongs to a different pairing. Refresh the listing.');
  const ids = useApp.getState().servers.filter(other => other.url === server.url && other.deviceId === server.deviceId).map(other => other.id);
  const finish = beginUploadRetirement(ids, file.upload.id);
  const assertUnused = (drafts: Record<string, DraftFile[]>, outboxes: Record<string, { attachments?: { id?: string }[] }[]>) => {
    if (uploadInUse(ids, file.upload.id, drafts, outboxes))
      throw new RetainedFileInUse('This file is still in a draft or outbox. Remove it from the draft or durably discard the queued message before releasing it.');
  };
  try {
    const state = useApp.getState();
    assertUnused(state.draftFiles, Object.fromEntries(ids.map(id => [id, state.runtime[id]?.outbox ?? []])));
    const savedDrafts = await cacheGetStrict<Record<string, DraftFile[]>>('draftFiles', {});
    const savedOutboxes = Object.fromEntries(await Promise.all(ids.map(async id => [id,
      await cacheGetStrict<{ attachments?: { id?: string }[] }[]>(`outbox:${id}`, [])])));
    assertUnused(savedDrafts, savedOutboxes);
    check(server);
    const latest = useApp.getState();
    assertUnused(latest.draftFiles, Object.fromEntries(ids.map(id => [id, latest.runtime[id]?.outbox ?? []])));
    await signedApi(server, 'DELETE', `/api/chats/${encodeApiComponent(file.chat_id)}/uploads/hold`,
      { hold_id: file.hold_id, upload_id: file.upload.id, expected_version: file.version });
    check(server);
  } finally { finish(); }
}

export async function retireConfirmedHolds(server: Server, chatId: string, holds: Set<string>): Promise<boolean> {
  if (!holds.size) return true;
  let protectedFiles = false;
  let after: string | undefined;
  for (let page = 0; page < 20 && holds.size; page++) {
    const result = await currentRetainedFiles(server, after);
    for (const file of result.files) if (file.chat_id === chatId && holds.has(file.hold_id)) {
      try { await releaseCurrentRetainedFile(server, file); }
      catch (error) {
        // A still-used or refreshed lease stays retained for the next explicit review.
        if (!(error instanceof RetainedFileInUse) && (error as { status?: number }).status !== 409) throw error;
        protectedFiles = true;
      }
    }
    if (!result.next) return !protectedFiles;
    after = result.next;
  }
  return false;
}
