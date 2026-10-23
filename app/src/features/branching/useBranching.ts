import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useApp } from '../../lib/store';
import type { BranchState, Server } from '../../lib/types';

/**
 * The server's real transcript mapping for this chat. Refresh on open, after a reply settles, and
 * when the bot starts or stops working; the server still re-checks its revision on every action.
 */
export function useBranching(server: Server, chatId: string, enabled = true) {
  const supported = useApp((st) => !!st.runtime[server.id]?.info?.features?.chat_branching);
  const online = useApp((st) => st.runtime[server.id]?.status === 'online');
  const lastReplyAt = useApp((st) => st.runtime[server.id]?.lastReplyAt);
  const typing = useApp((st) => !!st.runtime[server.id]?.typing[chatId]);
  const [state, setState] = useState<BranchState | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const active = useRef(true);
  active.current = enabled && supported && online;

  const refresh = useCallback(async () => {
    if (!enabled || !supported || !online) return;
    const request = ++seq.current;
    setLoading(true);
    try {
      const data = await api<BranchState>(server, `/api/branching/chats/${encodeURIComponent(chatId)}`);
      if (active.current && seq.current === request && (!data.chat_id || data.chat_id === chatId)) setState(data);
    } catch {
      // Offline or a server that predates the route: keep the last good snapshot. The menu shows
      // an offline hint rather than pretending the action is available.
    } finally {
      if (seq.current === request) setLoading(false);
    }
  }, [server, chatId, supported, online, enabled]);

  useEffect(() => {
    setState(null);
  }, [chatId]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [refresh, lastReplyAt, typing, enabled]);

  useEffect(() => {
    if (!enabled) setState(null);
  }, [enabled]);

  return {
    supported: supported && enabled,
    online,
    state: enabled ? state : null,
    loading,
    refresh,
  };
}
