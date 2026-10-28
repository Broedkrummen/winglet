import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, FadeOutUp } from 'react-native-reanimated';
import { FloatingPill } from '../../components/Sheet';
import { spring, useReducedMotion } from '../../lib/motion';
import { useApp, useServerState } from '../../lib/store';
import { makeStyles, useTheme } from '../../lib/themeContext';

/** Quiet and non-blocking: cached chats and the composer remain available while catching up. One line, at most. */
export function SyncStatus({ serverId, details = false }: { serverId: string; details?: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const rt = useServerState(serverId);
  const sync = rt?.sync;
  const reduced = useReducedMotion();
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
  const count = busy && sync.caught ? ` · ${sync.caught}` : '';
  const reason = details && sync.reason ? ` · ${sync.reason === 'network' ? 'Check connection and storage' : sync.reason}` : '';
  const text = <Text style={[s.text, blocked && { color: t.colors.danger }]} numberOfLines={1}>
    {details ? 'Sync · ' : ''}{label}{count}{reason}
  </Text>;
  const action = (blocked || details) && <Pressable accessibilityRole="button" accessibilityLabel={blocked ? 'Retry catching up' : 'Resync now'}
    disabled={busy} hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }} onPress={() => useApp.getState().resyncNow(serverId)}
    style={busy ? s.dim : undefined}>
    <Text style={s.action}>{blocked ? 'Retry' : 'Resync now'}</Text>
  </Pressable>;
  // On a settings screen it's a plain line; over a chat it's a small floating pill under the header.
  if (details) return <View accessibilityLiveRegion="polite" style={s.row}>{text}{action}</View>;
  return <Animated.View entering={reduced ? FadeIn.duration(120) : FadeIn.duration(180)}
    exiting={reduced ? FadeOut.duration(120) : FadeOutUp.duration(160)} accessibilityLiveRegion="polite" style={s.float}>
    <FloatingPill style={s.pill}>
      {busy ? <ActivityIndicator size="small" color={t.colors.accent} style={s.spinner} />
        : <View style={[s.dot, { backgroundColor: blocked ? t.colors.danger : t.colors.success }]} />}
      {text}{action}
    </FloatingPill>
  </Animated.View>;
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm, paddingHorizontal: t.space.lg, paddingVertical: t.space.xs },
  float: { alignSelf: 'center', maxWidth: 520, marginTop: t.space.sm, marginHorizontal: t.space.md },
  pill: { minHeight: 32, paddingHorizontal: t.space.md, paddingVertical: 6 },
  spinner: { transform: [{ scale: 0.75 }] },
  dot: { width: 7, height: 7, borderRadius: t.radius.pill },
  text: { ...t.type.caption, color: t.colors.textSecondary, flexShrink: 1 },
  action: { ...t.type.caption, fontFamily: t.fonts.semibold, color: t.colors.accent },
  dim: { opacity: 0.5 },
}));
