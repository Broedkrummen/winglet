import { useEffect } from 'react';
import { useApp } from '../../lib/store';
import { useLock } from '../../lib/appLock';
import { applyDeferredDrafts, bootPersonalSync, refreshPersonalSync, subscribePersonalSync } from './runtime';

/** Shares portable composition only while the app is open and unlocked. */
export function PersonalSyncBridge() {
  const foreground = useApp(state => state.foreground);
  const network = useApp(state => state.network);
  const visible = useApp(state => state.visibleChat);
  const locked = useLock(state => state.locked);
  useEffect(() => {
    const stop = subscribePersonalSync();
    void bootPersonalSync().then(() => refreshPersonalSync());
    return stop;
  }, []);
  useEffect(() => {
    void refreshPersonalSync();
    if (!foreground || !network || locked) return;
    const timer = setInterval(() => { void refreshPersonalSync(); }, 10000);
    return () => clearInterval(timer);
  }, [foreground, network, locked]);
  useEffect(() => { void applyDeferredDrafts().catch(() => undefined); }, [visible?.serverId, visible?.chatId]);
  return null;
}
