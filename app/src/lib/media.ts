import * as DocumentPicker from 'expo-document-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';
import { ApiError, botPath } from './api';
import type { Server, Upload } from './types';

/** A file chosen on this device, before it's uploaded. */
export type PickedFile = {
  uri: string;
  name: string;
  mime: string;
  size?: number;
  width?: number;
  height?: number;
  /** The browser's File, on the web. */
  file?: Blob;
  isImage?: boolean;
};

const MAX_EDGE = 2048;
export const MAX_FILES = 10;

/** Photos and videos from the gallery, several at once. */
export async function pickMedia(): Promise<PickedFile[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, selectionLimit: MAX_FILES, quality: 1, exif: false,
  });
  return result.canceled ? [] : result.assets.map(fromImageAsset);
}

/** A new photo from the camera. Null when the camera isn't allowed or the user backs out. */
export async function takePhoto(): Promise<PickedFile[] | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) return null;
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, exif: false });
  return result.canceled ? [] : result.assets.map(fromImageAsset);
}

/** Any files: documents, archives, audio. */
export async function pickFiles(): Promise<PickedFile[]> {
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: '*/*' });
  if (result.canceled) return [];
  return result.assets.slice(0, MAX_FILES).map((a) => ({
    uri: a.uri, name: a.name || 'file', mime: a.mimeType || 'application/octet-stream', size: a.size,
    file: (a as { file?: Blob }).file, isImage: (a.mimeType || '').startsWith('image/'),
  }));
}

function fromImageAsset(a: ImagePicker.ImagePickerAsset, i: number): PickedFile {
  const video = a.type === 'video';
  const mime = a.mimeType || (video ? 'video/mp4' : 'image/jpeg');
  return {
    uri: a.uri, name: a.fileName || `${video ? 'video' : 'photo'}-${Date.now()}-${i}.${mime.split('/')[1] || 'jpg'}`,
    mime, size: a.fileSize, width: a.width, height: a.height, file: (a as { file?: Blob }).file, isImage: !video,
  };
}

/**
 * Shrink a photo to at most 2048 px on its long edge and re-encode it as JPEG. Re-encoding drops
 * EXIF, so the photo's location never leaves the phone. GIFs keep their animation untouched.
 */
export async function preparePhoto(f: PickedFile, keepOriginal = false): Promise<PickedFile> {
  if (keepOriginal || !f.isImage || f.mime === 'image/gif') return f;
  const name = f.name.replace(/\.[^.]+$/, '') + '.jpg';
  try {
    if (Platform.OS === 'web') return await reencodeInBrowser(f, name);
    const scale = Math.max(f.width ?? 0, f.height ?? 0) > MAX_EDGE;
    const context = ImageManipulator.manipulate(f.uri);
    if (scale) context.resize((f.width ?? 0) >= (f.height ?? 0) ? { width: MAX_EDGE } : { height: MAX_EDGE });
    const image = await context.renderAsync();
    const saved = await image.saveAsync({ compress: 0.85, format: SaveFormat.JPEG });
    return { ...f, uri: saved.uri, name, mime: 'image/jpeg', width: saved.width, height: saved.height, size: undefined, file: undefined };
  } catch {
    return f; // an unusual format we can't decode: send it as it is
  }
}

async function reencodeInBrowser(f: PickedFile, name: string): Promise<PickedFile> {
  const blob = f.file ?? (await (await fetch(f.uri)).blob());
  const bitmap = await createImageBitmap(blob);
  const ratio = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * ratio);
  canvas.height = Math.round(bitmap.height * ratio);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!out) return f;
  return { ...f, file: out, uri: URL.createObjectURL(out), name, mime: 'image/jpeg', size: out.size, width: canvas.width, height: canvas.height };
}

export type UploadHandle = { promise: Promise<Upload>; abort: () => void };

/** Upload one file to a chat with progress; nothing is sent to the agent until a message attaches it. */
export function uploadFile(server: Server, chatId: string, f: PickedFile, onProgress: (p: number) => void, kind?: 'voice'): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Upload>((resolve, reject) => {
    xhr.open('POST', `${server.url}${botPath(server, `/api/chats/${encodeURIComponent(chatId)}/uploads`)}`);
    xhr.setRequestHeader('Authorization', `Bearer ${server.token}`);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data: any = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && data?.upload) resolve(data.upload as Upload);
      else reject(new ApiError(data?.error || `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError("Couldn't reach your server to upload. Try again when you're back online.", 0));
    xhr.onabort = () => reject(new ApiError('Cancelled', -1));
    const form = new FormData();
    if (kind) form.append('kind', kind);
    if (f.file) form.append('file', f.file as Blob, f.name);
    else form.append('file', { uri: f.uri, name: f.name, type: f.mime } as unknown as Blob);
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

export function formatSize(n?: number): string {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
