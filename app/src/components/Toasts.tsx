import { router } from 'expo-router';
import { Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, FadeOutUp, LinearTransition, SlideInUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { spring, useReducedMotion } from '../lib/motion';
import { useApp } from '../lib/store';
import { makeStyles } from '../lib/themeContext';
import { AgentFace } from './AgentFace';
import { Glass } from './Glass';
import { Tap } from './ui';

// Toasts drop in from above with a soft spring and float up out of the way when they go.
const ENTER = SlideInUp.springify().damping(spring.soft.damping).stiffness(spring.soft.stiffness);
const LEAVE = FadeOutUp.duration(200);
const MOVE = LinearTransition.springify().damping(spring.snappy.damping).stiffness(spring.snappy.stiffness);

/** In-app banners for things that happen outside the chat you're looking at: floating glass pills with the bot's face. */
export function Toasts() {
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const toasts = useApp((st) => st.toasts);
  const servers = useApp((st) => st.servers);
  const dismiss = useApp((st) => st.dismissToast);
  if (!toasts.length) return null;
  return (
    <View pointerEvents="box-none" style={[s.wrap, { top: insets.top + 8 }]}>
      {toasts.map((toast) => {
        const server = servers.find((x) => x.id === toast.serverId);
        return (
          <Animated.View key={toast.id} entering={reduced ? FadeIn.duration(120) : ENTER} exiting={reduced ? FadeOut.duration(120) : LEAVE}
            layout={reduced ? undefined : MOVE} style={s.slot}>
            <Tap feedback="selection" accessibilityRole="alert" accessibilityLabel={`${toast.title}. ${toast.body}`} scaleTo={0.97}
              onPress={() => { dismiss(toast.id); if (toast.href) router.push(toast.href as never); }} style={s.shadow}>
              <Glass intensity={60} style={[s.toast, !server && s.toastPlain]}>
                {server ? <View style={s.face}><AgentFace server={server} size={36} still /></View> : null}
                <View style={s.text}>
                  <Text style={s.title} numberOfLines={1}>{toast.title}</Text>
                  {toast.body ? <Text style={s.body} numberOfLines={2}>{toast.body}</Text> : null}
                </View>
              </Glass>
            </Tap>
          </Animated.View>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', gap: t.space.sm, paddingHorizontal: t.space.md, zIndex: 100 },
  slot: { maxWidth: 440, width: '100%', alignItems: 'center' },
  // The shadow lives outside the glass: glass clips its corners, which would clip a shadow drawn on it too.
  shadow: {
    maxWidth: '100%', borderRadius: t.radius.pill,
    shadowColor: t.colors.shadow, shadowOpacity: t.scheme === 'light' ? 0.16 : 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 10 },
  },
  toast: {
    flexDirection: 'row', alignItems: 'center', gap: t.space.md, borderRadius: t.radius.pill,
    paddingVertical: t.space.sm, paddingLeft: t.space.sm, paddingRight: t.space.xl, minHeight: 56, elevation: 8,
  },
  toastPlain: { paddingLeft: t.space.xl },
  face: { width: 40, height: 40, borderRadius: t.radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.surface },
  text: { flexShrink: 1, minWidth: 0, paddingVertical: 2 },
  title: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.text },
  body: { ...t.type.footnote, color: t.colors.textSecondary, marginTop: 1 },
}));
