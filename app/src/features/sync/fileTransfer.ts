import { sha256 } from '@noble/hashes/sha2.js';
import { apiBytes, encodeApiComponent, signedApi, signedBytesApi } from '../../lib/api';
import type { AttachmentKind, DraftFile, Server, Upload } from '../../lib/types';

export type SyncBlob = { id: string; sha256: string; name: string; mime: string; kind: AttachmentKind; size: number };
export type SyncFile = SyncBlob & { slot: string };
const digest = (bytes: Uint8Array) => Array.from(sha256(bytes), b => b.toString(16).padStart(2, '0')).join('');
const hashPattern = /^[0-9a-f]{64}$/;

export function validateSyncFile(file: SyncFile): void {
  const keys = ['id', 'sha256', 'name', 'mime', 'kind', 'size', 'slot'];
  if (!file || Object.keys(file).length !== keys.length || Object.keys(file).some(key => !keys.includes(key))
    || !hashPattern.test(file.id) || !hashPattern.test(file.sha256) || typeof file.name !== 'string'
    || !file.name || file.name.length > 255 || /[/\\\u0000-\u001f]/.test(file.name) || typeof file.mime !== 'string' || !file.mime || file.mime.length > 200
    || !['image', 'audio', 'video', 'file', 'voice'].includes(file.kind) || !Number.isSafeInteger(file.size)
    || file.size <= 0 || typeof file.slot !== 'string' || !file.slot || file.slot.length > 160)
    throw new Error('The shared file metadata is invalid. Keep the original file and refresh.');
}

export function stagingHoldId(target: Server, chatId: string, file: DraftFile): string {
  return `sync-stage:${digest(new TextEncoder().encode(JSON.stringify([target.id, chatId, file.upload?.id, file.localId])))}`;
}

/** Stage immutable bytes at the home; never copy another server's URL or credentials into a record. */
export async function stageSyncFile(home: Server, groupId: string, target: Server, chatId: string, file: DraftFile): Promise<SyncFile> {
  if (file.status !== 'ready' || !file.upload || file.autoSend) throw new Error('Wait for the file upload to finish before sharing this draft.');
  if (!file.upload.url.startsWith(`/api/media/${encodeURIComponent(file.upload.id)}/`))
    throw new Error('This file does not have a private server upload to stage. Attach it again.');
  // Retention is established before reading; a later outage cannot expire the only server copy.
  await signedApi(target, 'POST', `/api/chats/${encodeApiComponent(chatId)}/uploads/hold`,
    { upload_ids: [file.upload.id], hold_id: stagingHoldId(target, chatId, file) });
  const bytes = await apiBytes(target, file.upload.url);
  if (bytes.length !== file.upload.size) throw new Error('The source file size changed. Keep the original and attach it again.');
  const hash = digest(bytes);
  const path = `/api/user-sync/${encodeApiComponent(groupId)}/blobs/${hash}?name=${encodeApiComponent(file.upload.name)}&voice=${file.kind === 'voice' ? 1 : 0}`;
  const { blob } = await signedBytesApi<{ blob: SyncBlob }>(home, path, bytes);
  const result = { ...blob, slot: file.localId };
  validateSyncFile(result);
  if (result.sha256 !== hash || result.size !== bytes.length) throw new Error('The sync home did not confirm the exact file. Your source copy is kept.');
  return result;
}

/** A receiving device uses its own target pairing, and verifies bytes before any target upload. */
export async function materializeSyncFile(home: Server, groupId: string, target: Server, chatId: string, file: SyncFile): Promise<Upload & { hold_id: string }> {
  validateSyncFile(file);
  const bytes = await apiBytes(home, `/api/user-sync/${encodeApiComponent(groupId)}/blobs/${file.id}`);
  if (bytes.length !== file.size || digest(bytes) !== file.sha256) throw new Error('The shared file failed its integrity check. Nothing was uploaded to the target.');
  const path = `/api/chats/${encodeApiComponent(chatId)}/staged-files/${file.id}?slot=${encodeApiComponent(file.slot)}&sha256=${file.sha256}`
    + `&name=${encodeApiComponent(file.name)}&voice=${file.kind === 'voice' ? 1 : 0}`;
  const { upload } = await signedBytesApi<{ upload: Upload & { hold_id: string } }>(target, path, bytes);
  if (!upload?.id || !upload.hold_id || upload.size !== file.size || upload.name !== file.name || upload.mime !== file.mime || upload.kind !== file.kind)
    throw new Error('The target did not confirm a retained file copy. Your shared original is kept.');
  return upload;
}
