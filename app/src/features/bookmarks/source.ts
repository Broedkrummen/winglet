import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { api, encodeApiComponent } from '../../lib/api';
import { useLock } from '../../lib/appLock';
import { useApp } from '../../lib/store';
import type { Server } from '../../lib/types';
import type { BookmarkSource } from './model';

export type SourceAnswer = { state: 'available' | 'edited' | 'deleted'; sha256?: string;
  message?: { id: string; chat_id: string; text: string }; snapshot?: { id: string; sha256: string; text: string; truncated: number } };
export const sourcePath = (source: BookmarkSource, snapshot?: string) => `/api/chats/${encodeApiComponent(source.chat_id)}/${snapshot
  ? `bookmark-snapshots/${encodeApiComponent(snapshot)}` : `bookmark-source/${encodeApiComponent(source.message_id)}`}`;
const endpoint = (server?: Server) => server ? JSON.stringify([server.id, server.deviceId, server.url, server.token, server.fingerprint, server.profile]) : '';

/** Source contents are transient and never enter the personal-state journal/cache. */
export function useBookmarkSource(source: BookmarkSource, snapshot?: string, active = true) {
  const server = useApp(state => state.servers.find(item => item.id === source.server_id && item.fingerprint === source.server_fingerprint));
  const foreground = useApp(state => state.foreground), locked = useLock(state => state.locked);
  const [focused, setFocused] = useState(false), [reload, setReload] = useState(0);
  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false); }, []));
  const enabled = active && focused && foreground && !locked && !!server;
  const identity = endpoint(server), path = sourcePath(source, snapshot);
  const key = `${identity}:${path}`;
  const [result, setResult] = useState<{ key: string; data?: SourceAnswer; error?: string }>();
  useEffect(() => {
    setResult(undefined);
    if (!enabled || !server) return;
    let current = true;
    let inFlight = false;
    const controller = new AbortController();
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const data = await api<SourceAnswer>(server, path, { cache: 'no-store', signal: controller.signal });
        if (current && !useLock.getState().locked && useApp.getState().foreground
          && endpoint(useApp.getState().servers.find(item => item.id === server.id)) === identity) {
          if (!['available', 'edited', 'deleted'].includes(data?.state)
            || (data.message && (data.message.id !== source.message_id || data.message.chat_id !== source.chat_id || typeof data.message.text !== 'string'))
            || (data.snapshot && (data.snapshot.id !== snapshot || typeof data.snapshot.text !== 'string' || data.snapshot.text.length > 16384)))
            throw new Error('Invalid saved answer response. Update the source server and retry.');
          setResult({ key, data });
        }
      } catch { if (current) setResult({ key, error: 'Source unavailable. Reconnect, check access or update the original bot’s Winglet server.' }); }
      finally { inFlight = false; }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 15000);
    return () => { current = false; controller.abort(); clearInterval(timer); };
  }, [enabled, key, reload]); // Endpoint identity captures the paired credentials without persisting them.
  return { server, data: enabled && result?.key === key ? result.data : undefined,
    error: !server ? 'Pair with the matching source server to open this answer.' : enabled && result?.key === key ? result.error : undefined,
    refresh: () => setReload(value => value + 1), enabled };
}
