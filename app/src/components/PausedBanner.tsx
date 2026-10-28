import { useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, FadeOutUp } from 'react-native-reanimated';
import { signedApi } from '../lib/api';
import { haptic } from '../lib/haptics';
import { spring, useReducedMotion } from '../lib/motion';
import { isOwner, useApp } from '../lib/store';
import { alpha } from '../lib/theme';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { PauseState, Server } from '../lib/types';
import { CirclePause, Play } from './icons';
import { FloatingPill } from './Sheet';
import { Tap } from './ui';

/** New work is on hold, so a message here gets Hermes's "paused" reply. Owners can resume in place. */
export function PausedBanner({ server }: { server: Server }) {
  const t = useTheme();
  const s = useStyles();
  const rt = useApp((st) => st.runtime[server.id]);
  const [busy, setBusy] = useState(false);
  const reduced = useReducedMotion();
  if (!rt?.paused || rt.status !== 'online') return null;
  const owner = isOwner(rt);

  const resume = async () => {
    setBusy(true);
    try {
      const r = await signedApi<{ paused: PauseState }>(server, 'POST', '/api/system/pause', { paused: false });
      useApp.setState((st) => ({ runtime: { ...st.runtime, [server.id]: { ...st.runtime[server.id], paused: r.paused } } }));
      haptic.success();
    } catch (e) {
      haptic.error();
      useApp.getState().toast({ serverId: server.id, title: "Couldn't resume", body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Animated.View entering={reduced ? FadeIn.duration(120) : FadeIn.duration(180)}
      exiting={reduced ? FadeOut.duration(120) : FadeOutUp.duration(160)} accessibilityRole="alert" style={s.float}>
      <FloatingPill style={s.pill}>
        <View style={s.icon}><CirclePause size={16} color={t.colors.warning} /></View>
        <View style={s.text}>
          <Text style={s.title} numberOfLines={1}>Paused</Text>
          <Text style={s.detail} numberOfLines={1}>
            {owner ? "It won't start anything new until you resume." : 'An owner paused new work for now.'}
          </Text>
        </View>
        {owner ? (
          <Tap feedback="selection" accessibilityLabel="Resume" hitSlop={4} style={s.button} onPress={() => !busy && resume()}>
            {busy ? <ActivityIndicator size="small" color={t.colors.onAccentSoft} /> : <Play size={13} color={t.colors.textSecondary} fill={t.colors.onAccentSoft} />}
            <Text style={s.buttonText}>Resume</Text>
          </Tap>
        ) : null}
      </FloatingPill>
    </Animated.View>
  );
}

const useStyles = makeStyles((t) => ({
  float: { alignSelf: 'center', maxWidth: 560, marginTop: t.space.sm, marginHorizontal: t.space.md },
  pill: { gap: 10, paddingLeft: 6, paddingRight: 6, paddingVertical: 6, borderColor: alpha(t.colors.warning, 0.45) },
  icon: { width: 34, height: 34, borderRadius: t.radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.warningSoft },
  text: { flexShrink: 1, minWidth: 0, paddingRight: t.space.xs },
  title: { ...t.type.footnote, fontFamily: t.fonts.semibold, color: t.colors.text },
  detail: { ...t.type.caption, fontSize: 11.5, lineHeight: 14, color: t.colors.textSecondary },
  button: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 14, borderRadius: t.radius.pill,
    backgroundColor: t.colors.accentSoft,
  },
  buttonText: { fontFamily: t.fonts.semibold, fontSize: 13.5, color: t.colors.onAccentSoft },
}));
