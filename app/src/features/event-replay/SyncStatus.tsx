import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useApp, useServerState } from '../../lib/store';
import { useTheme } from '../../lib/themeContext';

/** Quiet and non-blocking: cached chats and the composer remain available while catching up. */
export function SyncStatus({ serverId, details = false }: { serverId: string; details?: boolean }) {
  const t = useTheme();
  const rt = useServerState(serverId);
  const sync = rt?.sync;
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    if (sync?.phase !== 'idle') return;
    const timer = setTimeout(() => setSettled(true), 2000);
    return () => clearTimeout(timer);
  }, [sync]);
  if (!sync || sync.phase === 'unsupported' || rt?.status !== 'online') return null;
  if (!details && sync.phase === 'idle' && (!sync.caught || settled)) return null;
  const busy = sync.phase === 'snapshot' || sync.phase === 'catching-up';
  const blocked = sync.phase === 'blocked';
  const label = blocked ? "Couldn't catch up" : busy ? 'Catching up…' : details ? 'Up to date' : 'Back in sync';
  return <View accessibilityLiveRegion="polite" style={{ paddingHorizontal: 16, paddingVertical: 4, flexDirection: 'row',
    flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
    <Text style={{ color: blocked ? t.colors.danger : t.colors.textSecondary, fontSize: 12, flexShrink: 1 }}>
      {details ? 'Sync · ' : ''}{label}{busy && sync.caught ? ` · ${sync.caught}` : ''}
      {details && sync.reason ? ` · ${sync.reason === 'network' ? 'Check connection and storage' : sync.reason}` : ''}
    </Text>
    {(blocked || details) && <Pressable accessibilityRole="button" accessibilityLabel={blocked ? 'Retry catching up' : 'Resync now'}
      disabled={busy} onPress={() => useApp.getState().resyncNow(serverId)}
      style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', opacity: busy ? 0.5 : 1 }}>
      <Text style={{ color: t.colors.accent, fontSize: 12 }}>{blocked ? 'Retry' : 'Resync now'}</Text>
    </Pressable>}
  </View>;
}
