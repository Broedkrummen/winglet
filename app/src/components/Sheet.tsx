import { useEffect, useState, type ReactNode } from 'react';
import { Keyboard, Modal, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView, ScrollView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLock } from '../lib/appLock';
import { haptic } from '../lib/haptics';
import { spring, useReducedMotion } from '../lib/motion';
import { makeStyles, useTheme } from '../lib/themeContext';
import { Glass } from './Glass';
import { X } from './icons';

/**
 * A bottom sheet: springs up, drags down to dismiss, closes on the backdrop or the back button.
 * On wide screens it becomes a centred dialog.
 */
export function Sheet({ visible, onClose, onDismiss, title, children, scrollable = false }: {
  visible: boolean; onClose: () => void; onDismiss?: () => void; title?: string; children: ReactNode;
  scrollable?: boolean;
}) {
  const t = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const wide = width >= 700;
  const reduced = useReducedMotion();
  const locked = useLock((st) => st.locked);
  const [mounted, setMounted] = useState(visible);
  const keyboard = useKeyboardHeight(visible);
  const y = useSharedValue(height);
  const fade = useSharedValue(0);
  const dismissed = () => { setMounted(false); onDismiss?.(); };

  useEffect(() => {
    if (visible) {
      setMounted(true);
      haptic.light();
      fade.value = withTiming(1, { duration: reduced ? 0 : 200 });
      y.value = reduced ? 0 : withSpring(0, spring.soft);
    } else if (mounted) {
      fade.value = withTiming(0, { duration: reduced ? 0 : 180 });
      y.value = withTiming(reduced ? 0 : height, { duration: reduced ? 0 : 220 }, (done) => { if (done) runOnJS(dismissed)(); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const pan = Gesture.Pan()
    .activeOffsetY(8)
    .failOffsetX([-20, 20])
    .onUpdate((e) => { y.value = Math.max(0, e.translationY); })
    .onEnd((e) => {
      if (e.translationY > 120 || e.velocityY > 900) runOnJS(onClose)();
      else y.value = withSpring(0, spring.soft);
    })
    .onFinalize((_e, success) => { if (!success) y.value = withSpring(0, spring.soft); });

  const panel = useAnimatedStyle(() => ({ transform: [{ translateY: wide ? y.value * 0.15 : y.value }], opacity: wide ? fade.value : 1 }));
  const backdrop = useAnimatedStyle(() => ({ opacity: fade.value }));

  // A native modal sits above the lock screen: unmount it while locked. An open sheet comes back on unlocking.
  if (!mounted || locked) return null;
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: t.colors.overlay }, backdrop]}>
          <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="Close sheet" onPress={onClose} />
        </Animated.View>
        <View style={[s.host, wide && s.hostWide, keyboard ? { paddingBottom: keyboard } : null]} pointerEvents="box-none">
            <Animated.View style={[s.panel, { maxHeight: Math.max(0, height - Math.max(insets.top, 12) - 12 - keyboard) }, wide && s.panelWide, panel]} accessibilityViewIsModal>
              <Glass style={[s.glass, wide && { borderRadius: t.radius.xl }, { paddingBottom: wide ? 20 : keyboard ? 12 : insets.bottom + 16 }]}>
                <GestureDetector gesture={pan}>
                  <View style={s.handle}>
                    {wide ? null : <View style={s.grabber} />}
                    <View style={s.heading}>
                      <Text style={s.title} accessibilityRole="header">{title}</Text>
                      <Pressable accessibilityRole="button" accessibilityLabel="Close sheet" hitSlop={4} onPress={onClose}
                        style={({ pressed }) => [s.close, pressed && { backgroundColor: t.colors.pressed }]}><X size={20} color={t.colors.textSecondary} /></Pressable>
                    </View>
                  </View>
                </GestureDetector>
                {scrollable ? <ScrollView style={s.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">{children}</ScrollView>
                  : <View style={s.content}>{children}</View>}
              </Glass>
            </Animated.View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

/**
 * The keyboard's height while a sheet is open. A sheet is a native modal drawn edge to edge, so its window
 * doesn't shrink for the keyboard: a text field in it would sit behind the keys without this.
 */
function useKeyboardHeight(active: boolean): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!active || Platform.OS === 'web') return;
    setHeight(Keyboard.metrics?.()?.height ?? 0);
    const ios = Platform.OS === 'ios';
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', (e) => setHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setHeight(0));
    return () => { show.remove(); hide.remove(); setHeight(0); };
  }, [active]);
  return height;
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
  panel: { width: '100%', flexShrink: 1 },
  panelWide: { maxWidth: 460 },
  glass: {
    borderTopLeftRadius: t.radius.xl, borderTopRightRadius: t.radius.xl, paddingHorizontal: 16, paddingTop: 10,
    flexShrink: 1,
  },
  grabber: { alignSelf: 'center', width: 38, height: 5, borderRadius: 3, backgroundColor: t.colors.borderStrong, marginBottom: 6 },
  handle: { flexShrink: 0 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 4, marginBottom: 6 },
  title: { ...t.type.heading, color: t.colors.text, flex: 1 },
  close: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20, backgroundColor: t.colors.surfaceSunken },
  content: { flexShrink: 1, minHeight: 0 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52, paddingHorizontal: 12, borderRadius: t.radius.md },
  actionText: { ...t.type.body, fontFamily: t.fonts.medium, color: t.colors.text },
}));
