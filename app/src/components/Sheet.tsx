import { useEffect, useState, type ReactNode } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLock } from '../lib/appLock';
import { haptic } from '../lib/haptics';
import { spring, useReducedMotion } from '../lib/motion';
import { makeStyles, useTheme } from '../lib/themeContext';
import { Glass } from './Glass';

/**
 * A bottom sheet: springs up, drags down to dismiss, closes on the backdrop or the back button.
 * On wide screens it becomes a centred dialog.
 */
export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  const t = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const wide = width >= 700;
  const reduced = useReducedMotion();
  const locked = useLock((st) => st.locked);
  const [mounted, setMounted] = useState(visible);
  const y = useSharedValue(height);
  const fade = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      haptic.light();
      fade.value = withTiming(1, { duration: 200 });
      y.value = reduced ? 0 : withSpring(0, spring.soft);
    } else if (mounted) {
      fade.value = withTiming(0, { duration: 180 });
      y.value = withTiming(reduced ? 0 : height, { duration: 220 }, (done) => { if (done) runOnJS(setMounted)(false); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const pan = Gesture.Pan()
    .activeOffsetY(8)
    .onUpdate((e) => { y.value = Math.max(0, e.translationY); })
    .onEnd((e) => {
      if (e.translationY > 120 || e.velocityY > 900) runOnJS(onClose)();
      else y.value = withSpring(0, spring.soft);
    });

  const panel = useAnimatedStyle(() => ({ transform: [{ translateY: wide ? y.value * 0.15 : y.value }], opacity: wide ? fade.value : 1 }));
  const backdrop = useAnimatedStyle(() => ({ opacity: fade.value }));

  // A native modal sits above the lock screen: unmount it while locked. An open sheet comes back on unlocking.
  if (!mounted || locked) return null;
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: t.colors.overlay }, backdrop]}>
          <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Close" onPress={onClose} />
        </Animated.View>
        <View style={[s.host, wide && s.hostWide]} pointerEvents="box-none">
          <GestureDetector gesture={pan}>
            <Animated.View style={[s.panel, wide && s.panelWide, panel]} accessibilityViewIsModal>
              <Glass style={[s.glass, wide && { borderRadius: t.radius.xl }, { paddingBottom: wide ? 20 : insets.bottom + 16 }]}>
                {wide ? null : <View style={s.grabber} />}
                {title ? <Text style={s.title} accessibilityRole="header">{title}</Text> : null}
                {children}
              </Glass>
            </Animated.View>
          </GestureDetector>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

/** One action row inside a sheet. */
export function SheetAction({ icon, label, onPress, destructive }: { icon?: ReactNode; label: string; onPress: () => void; destructive?: boolean }) {
  const t = useTheme();
  const s = useStyles();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => { haptic.selection(); onPress(); }}
      style={({ pressed }) => [s.action, pressed && { backgroundColor: t.colors.pressed }]}>
      {icon}
      <Text style={[s.actionText, destructive && { color: t.colors.danger }]}>{label}</Text>
    </Pressable>
  );
}

const useStyles = makeStyles((t) => ({
  host: { flex: 1, justifyContent: 'flex-end' },
  hostWide: { justifyContent: 'center', alignItems: 'center', padding: 24 },
  panel: { width: '100%' },
  panelWide: { maxWidth: 460 },
  glass: {
    borderTopLeftRadius: t.radius.xl, borderTopRightRadius: t.radius.xl, paddingHorizontal: 16, paddingTop: 10,
    ...(Platform.OS === 'web' ? {} : {}),
  },
  grabber: { alignSelf: 'center', width: 38, height: 5, borderRadius: 3, backgroundColor: t.colors.borderStrong, marginBottom: 10 },
  title: { ...t.type.heading, color: t.colors.text, textAlign: 'center', marginBottom: 12 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52, paddingHorizontal: 12, borderRadius: t.radius.md },
  actionText: { ...t.type.body, fontFamily: t.fonts.medium, color: t.colors.text },
}));
