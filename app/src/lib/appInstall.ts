import { Directory, File, Paths } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { Linking } from 'react-native';
import { create } from 'zustand';
import type { AppUpdate } from './appUpdate';

/** Where downloaded updates wait for the installer. Emptied on every start, since by then they're installed or abandoned. */
const updatesDir = () => new Directory(Paths.cache, 'updates');
const APK_TYPE = 'application/vnd.android.package-archive';
const GRANT_READ_URI_PERMISSION = 1;

type Phase = 'idle' | 'downloading' | 'ready' | 'error';

type State = {
  phase: Phase;
  /** 0 to 1 while downloading; null when the server didn't say how big the file is. */
  progress: number | null;
  /** The version being downloaded or ready to install. */
  version?: string;
  error?: string;
  /** Downloads the update and opens Android's installer. Without an APK, opens the release page instead. */
  install: (update: AppUpdate) => Promise<void>;
  cancel: () => void;
};

let abort: AbortController | null = null;
let downloaded: File | null = null;

/** Downloading and installing a newer Android app from inside the app. */
export const useAppInstall = create<State>((set, get) => ({
  phase: 'idle',
  progress: null,
  install: async (update) => {
    if (!update.apk) {
      await Linking.openURL(update.page);
      return;
    }
    if (get().phase === 'downloading') return;
    // Already downloaded (the installer was closed without installing): just open it again.
    if (get().phase === 'ready' && get().version === update.version && downloaded?.exists) {
      await openInstaller(downloaded).catch(() => set({ phase: 'error', error: "Android's installer didn't open." }));
      return;
    }
    const controller = new AbortController();
    abort = controller;
    set({ phase: 'downloading', progress: 0, version: update.version, error: undefined });
    try {
      const dir = updatesDir();
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
      const file = new File(dir, `winglet-${update.version}.apk`);
      if (file.exists) file.delete();
      await File.downloadFileAsync(update.apk, file, {
        idempotent: true,
        signal: controller.signal,
        onProgress: ({ bytesWritten, totalBytes }) => set({ progress: totalBytes > 0 ? Math.min(1, bytesWritten / totalBytes) : null }),
      });
      // Native completion can race with cancellation and resolve instead of rejecting.
      if (controller.signal.aborted) {
        set({ phase: 'idle', progress: null });
        return;
      }
      if (update.apkSize && file.size !== update.apkSize) {
        file.delete();
        throw new Error('The download was incomplete. Try again.');
      }
      downloaded = file;
      set({ phase: 'ready', progress: 1 });
      await openInstaller(file);
    } catch (e) {
      if (controller.signal.aborted) {
        set({ phase: 'idle', progress: null });
        return;
      }
      const message = e instanceof Error && e.message.startsWith('The download') ? e.message
        : get().phase === 'ready' ? "Android's installer didn't open."
        : "Couldn't download the update. Check your connection and try again.";
      set({ phase: 'error', error: message });
    } finally {
      abort = null;
    }
  },
  cancel: () => abort?.abort(),
}));

/** Android checks the APK is signed with the same key as this app, and asks before installing. */
function openInstaller(file: File) {
  return IntentLauncher.startActivityAsync('android.intent.action.VIEW', { data: file.contentUri, type: APK_TYPE, flags: GRANT_READ_URI_PERMISSION });
}

/** Deletes downloads left from an earlier run. */
export function clearUpdateDownloads() {
  try {
    const dir = updatesDir();
    if (dir.exists) dir.delete();
  } catch {
    // Only a few cached megabytes; never worth failing a start over.
  }
}
