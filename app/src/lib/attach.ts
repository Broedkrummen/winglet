import { Platform } from 'react-native';
import { haptic } from './haptics';
import { preparePhoto, uploadFile, type PickedFile, type UploadHandle } from './media';
import { useApp } from './store';
import type { AttachmentKind, DraftFile } from './types';

// Uploads in flight, so they can be cancelled; and the original picks, so a failure can be retried.
const handles = new Map<string, UploadHandle>();
const originals = new Map<string, { file: PickedFile; keepOriginal: boolean; voice: boolean }>();

function kindFor(mime: string, voice: boolean): AttachmentKind {
  if (voice) return 'voice';
  if (/^image\/(png|jpeg|gif|webp|avif)$/.test(mime)) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

const newId = () => `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * Attach files to a chat's composer and start uploading them straight away, so sending is instant.
 * Voice notes send themselves as soon as their upload finishes.
 */
export function attachFiles(serverId: string, chatId: string, files: PickedFile[], opts: { keepOriginal?: boolean; voice?: boolean } = {}) {
  const { updateDraftFiles } = useApp.getState();
  for (const file of files) {
    const localId = newId();
    const voice = !!opts.voice;
    originals.set(localId, { file, keepOriginal: !!opts.keepOriginal, voice });
    const draft: DraftFile = {
      localId, name: file.name, mime: file.mime, kind: kindFor(file.mime, voice), size: file.size,
      previewUri: file.isImage ? file.uri : undefined, progress: 0, status: 'uploading', autoSend: voice,
    };
    updateDraftFiles(serverId, chatId, (list) => [...list, draft]);
    start(serverId, chatId, localId);
  }
}

function patch(serverId: string, chatId: string, localId: string, change: Partial<DraftFile>) {
  useApp.getState().updateDraftFiles(serverId, chatId, (list) => list.map((f) => (f.localId === localId ? { ...f, ...change } : f)));
}

async function start(serverId: string, chatId: string, localId: string) {
  const server = useApp.getState().servers.find((s) => s.id === serverId);
  const original = originals.get(localId);
  if (!server || !original) return;
  patch(serverId, chatId, localId, { status: 'uploading', progress: 0, error: undefined });
  try {
    const prepared = await preparePhoto(original.file, original.keepOriginal);
    // On the web a recording or pasted file may only exist as a blob: URL.
    if (Platform.OS === 'web' && !prepared.file) prepared.file = await (await fetch(prepared.uri)).blob();
    const handle = uploadFile(server, chatId, prepared, (p) => patch(serverId, chatId, localId, { progress: p }), original.voice ? 'voice' : undefined);
    handles.set(localId, handle);
    const upload = await handle.promise;
    handles.delete(localId);
    patch(serverId, chatId, localId, { status: 'ready', progress: 1, upload, kind: upload.kind, mime: upload.mime, size: upload.size, name: upload.name });
    const draft = useApp.getState().draftFiles[`${serverId}:${chatId}`]?.find((f) => f.localId === localId);
    if (draft?.autoSend) {
      haptic.light();
      const queued = await useApp.getState().sendMessage(serverId, chatId, '', { attachments: [upload], waitForDelivery: false });
      if (!queued) {
        patch(serverId, chatId, localId, { autoSend: false });
        throw new Error('Voice note not queued. Free some storage, then retry.');
      }
      useApp.getState().updateDraftFiles(serverId, chatId, (list) => list.filter((f) => f.localId !== localId));
      originals.delete(localId);
    }
  } catch (e) {
    handles.delete(localId);
    const status = (e as { status?: number }).status;
    if (status === -1) return; // cancelled: already removed
    haptic.error();
    patch(serverId, chatId, localId, { status: 'failed', error: (e as Error).message });
  }
}

export function retryFile(serverId: string, chatId: string, localId: string) {
  start(serverId, chatId, localId);
}

export function removeFile(serverId: string, chatId: string, localId: string) {
  handles.get(localId)?.abort();
  handles.delete(localId);
  originals.delete(localId);
  useApp.getState().updateDraftFiles(serverId, chatId, (list) => list.filter((f) => f.localId !== localId));
}

/** Whether the composer can send: some text or a file, and nothing still uploading. */
export function canSend(text: string, files: DraftFile[]): boolean {
  if (files.some((f) => f.status === 'uploading')) return false;
  return !!text.trim() || files.some((f) => f.status === 'ready');
}

/** Send the composer's text, ready files and reply, then clear them. */
export async function sendDraft(serverId: string, chatId: string, text: string, prefix = '') {
  const state = useApp.getState();
  const key = `${serverId}:${chatId}`;
  const files = (state.draftFiles[key] ?? []).filter((f) => f.status === 'ready' && f.upload);
  const replyTo = state.replyTo[key];
  const body = prefix && text.trim() ? `${prefix} ${text.trim()}` : text.trim();
  if (!body && !files.length) return false;
  const queued = await state.sendMessage(serverId, chatId, body, { attachments: files.map((f) => f.upload!), replyTo, waitForDelivery: false });
  if (!queued) return false;
  const current = useApp.getState();
  if (current.drafts[key] === text) current.setDraft(serverId, chatId, '');
  if (current.replyTo[key] === replyTo) current.setReplyTo(serverId, chatId, undefined);
  current.updateDraftFiles(serverId, chatId, (list) => list.filter((f) => !files.some((sent) => sent.localId === f.localId)));
  files.forEach((f) => originals.delete(f.localId));
  return true;
}
