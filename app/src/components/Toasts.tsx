import { router } from 'expo-router';
import { Text, View } from 'react-native';
import Animated, { FadeOutUp, LinearTransition, SlideInUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../lib/store';
import { makeStyles } from '../lib/themeContext';
import { BotAvatar } from './BotAvatar';
import { Glass } from './Glass';
import { Tap } from './ui';
import { easeOut } from '../lib/motion';

/** In-app banners for things that happen outside the chat you're looking at. */
export function Toasts() {
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const toasts = useApp((st) => st.toasts);
  const servers = useApp((st) => st.servers);
  const dismiss = useApp((st) => st.dismissToast);
  if (!toasts.length) return null;
  return (
    <View pointerEvents="box-none" style={[s.wrap, { top: insets.top + 8 }]}>
      {toasts.map((toast) => {
        const server = servers.find((x) => x.id === toast.serverId);
        return (
          <Animated.View key={toast.id} entering={SlideInUp.duration(260).easing(easeOut)} exiting={FadeOutUp.duration(180)}
            layout={LinearTransition.duration(220).easing(easeOut)} style={s.slot}>
            <Tap feedback="selection" accessibilityRole="alert" accessibilityLabel={`${toast.title}. ${toast.body}`} scaleTo={0.98}
              onPress={() => { dismiss(toast.id); if (toast.href) router.push(toast.href as never); }}>
              <Glass style={s.toast}>
                {server ? <BotAvatar name={server.bot.name} size={36} /> : null}
                <View style={{ flex: 1 }}>
                  <Text style={s.title} numberOfLines={1}>{toast.title}</Text>
                  <Text style={s.body} numberOfLines={2}>{toast.body}</Text>
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
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', gap: 8, paddingHorizontal: 12, zIndex: 100 },
  slot: { width: '100%', maxWidth: 460 },
  toast: {
    flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: t.radius.lg, padding: 12,
    shadowColor: t.colors.shadow, shadowOpacity: t.scheme === 'light' ? 0.15 : 0.5, shadowRadius: 22, shadowOffset: { width: 0, height: 10 }, elevation: 10,
  },
  title: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.text },
  body: { ...t.type.callout, fontSize: 13.5, color: t.colors.textSecondary, marginTop: 1 },
}));
