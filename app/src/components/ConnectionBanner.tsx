import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, FadeOutUp } from 'react-native-reanimated';
import { connectionView } from '../lib/connection';
import { spring, useReducedMotion } from '../lib/motion';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Server } from '../lib/types';
import { CloudOff, RefreshCw, WifiOff } from './icons';
import { FloatingPill } from './Sheet';
import { Tap } from './ui';

/** Why a bot isn't reachable, with the one thing to do about it. Hidden while online. */
export function ConnectionBanner({ server, compact }: { server: Server; compact?: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const rt = useApp((st) => st.runtime[server.id]);
  const network = useApp((st) => st.network);
  const retryNow = useApp((st) => st.retryNow);
  const reduced = useReducedMotion();
  const [now, setNow] = useState(Date.now());
  const view = connectionView(network, rt, server.bot.title, now);

  // Keep the "trying again in Ns" countdown honest.
  useEffect(() => {
    if (view.kind !== 'unreachable') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [view.kind]);

  if (view.kind === 'online' || view.kind === 'connecting') return null;
  const tint = view.tone === 'error' ? t.colors.danger : view.tone === 'warn' ? t.colors.warning : t.colors.accent;
  const soft = view.tone === 'error' ? t.colors.dangerSoft : view.tone === 'warn' ? t.colors.warningSoft : t.colors.accentSoft;
  const Icon = view.kind === 'no-internet' ? WifiOff : CloudOff;
  const action = view.action === 'retry' ? 'Try now' : view.action === 'pair' ? 'Pair again' : view.action === 'about' ? 'How to update' : null;

  const body = (
    <>
      <View style={[s.icon, compact && s.iconCompact, { backgroundColor: soft }]}>
        {view.kind === 'recovering' ? <ActivityIndicator size="small" color={tint} /> : <Icon size={compact ? 16 : 17} color={tint} />}
      </View>
      <View style={compact ? s.textCompact : s.text}>
        <Text style={[s.title, compact && s.titleCompact]} numberOfLines={compact ? 1 : undefined}>{view.title}</Text>
        {!compact && view.detail ? <Text style={s.detail}>{view.detail}</Text> : null}
        <Text accessibilityRole="link" style={[s.link, compact && s.linkCompact]} onPress={() => router.push(`/connection/${server.id}`)}>Details</Text>
      </View>
      {action ? (
        <Tap feedback="selection" accessibilityLabel={action} hitSlop={4} style={s.button} onPress={() => {
          if (view.action === 'retry') retryNow(server.id);
          else if (view.action === 'pair') router.push('/pair');
          else router.push('/about');
        }}>
          {view.action === 'retry' ? <RefreshCw size={14} color={t.colors.textSecondary} /> : null}
          <Text style={s.buttonText}>{action}</Text>
        </Tap>
      ) : null}
    </>
  );

  return (
    <Animated.View entering={reduced ? FadeIn.duration(120) : FadeIn.duration(180)}
      exiting={reduced ? FadeOut.duration(120) : FadeOutUp.duration(160)} accessibilityRole="alert"
      accessibilityLiveRegion="polite" style={compact ? s.float : s.banner}>
      {compact ? <FloatingPill style={s.pill}>{body}</FloatingPill> : body}
    </Animated.View>
  );
}

const useStyles = makeStyles((t) => ({
  // Full size (the connection screen): a frosted card. Compact (over a chat or a list): a floating glass pill.
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10, padding: t.space.md, borderRadius: t.radius.lg,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
  },
  float: { alignSelf: 'center', maxWidth: 560, marginTop: t.space.sm, marginHorizontal: t.space.md },
  pill: { gap: 10, paddingLeft: 6, paddingRight: 6, paddingVertical: 6 },
  icon: { width: 40, height: 40, borderRadius: t.radius.pill, alignItems: 'center', justifyContent: 'center' },
  iconCompact: { width: 34, height: 34 },
  text: { flex: 1, minWidth: 0 },
  textCompact: { flexShrink: 1, minWidth: 0, paddingRight: t.space.xs },
  title: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.text },
  titleCompact: { ...t.type.footnote, fontFamily: t.fonts.semibold },
  detail: { ...t.type.caption, fontFamily: t.fonts.regular, fontSize: 13, color: t.colors.textSecondary, marginTop: 2 },
  link: { ...t.type.caption, fontFamily: t.fonts.semibold, color: t.colors.accent, marginTop: 4, alignSelf: 'flex-start' },
  linkCompact: { marginTop: 0, fontSize: 11.5, lineHeight: 14 },
  button: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 14, borderRadius: t.radius.pill,
    backgroundColor: t.colors.accentSoft,
  },
  buttonText: { fontFamily: t.fonts.semibold, fontSize: 13.5, color: t.colors.onAccentSoft },
}));
