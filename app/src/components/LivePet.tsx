import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withSpring, withTiming,
} from 'react-native-reanimated';
import { haptic } from '../lib/haptics';
import { spring, useReducedMotion } from '../lib/motion';
import { holdCancelled, holdReaction, shownState, tapReaction, type Reaction } from '../lib/petPlay';
import { sound } from '../lib/sounds';
import { useApp } from '../lib/store';
import type { Server } from '../lib/types';
import { AgentFace, useAvatarColor, useRealPetState } from './AgentFace';

const LEAN_MAX_DEG = 12;
/** Held this long, a press becomes a hold. */
const HOLD_MS = 350;

type LivePetProps = {
  server: Server;
  size: number;
  glow?: boolean;
  bare?: boolean;
  status?: 'online' | 'offline' | 'connecting' | 'busy';
  /** Called after the tap reaction starts (the tab-bar pet opens quick-ask). */
  onTap?: () => void;
  /** Replace the long-press reaction: start/finish a hold (the tab-bar pet records a voice note). */
  onHoldStart?: () => void;
  onHoldEnd?: (cancelled: boolean) => void;
  accessibilityLabel?: string;
  /** Let a surrounding horizontal pager own swipes instead of leaning the pet. */
  draggable?: boolean;
  /** Keep neighboring deck pets mounted, but pause their loops and touch reactions. */
  active?: boolean;
};

/**
 * The agent's face where it's alive: poke it and it waves (three quick pokes and it jumps), hold it and it
 * thinks, drag it and it leans after your finger. Only Hermes's own animations; a reaction plays once and
 * then the pet goes back to what the agent is really doing.
 */
export function LivePet({ server, size, glow, bare, status, onTap, onHoldStart, onHoldEnd, accessibilityLabel, draggable = true, active = true }: LivePetProps) {
  const reduced = useReducedMotion();
  const foreground = useApp((st) => st.foreground);
  const pet = useApp((st) => st.runtime[server.id]?.pet);
  const loopMs = pet?.loop_ms ?? 1100;
  const real = useRealPetState(server, active);
  const color = useAvatarColor(server);
  const [reaction, setReaction] = useState<Reaction>(null);
  const taps = useRef<number[]>([]);

  // End the reaction when it runs out, so the real state comes back without anything else changing.
  useEffect(() => {
    if (!reaction || reaction.until === Infinity) return;
    const id = setTimeout(() => setReaction(null), Math.max(0, reaction.until - Date.now()));
    return () => clearTimeout(id);
  }, [reaction]);

  const float = useSharedValue(0);
  const squash = useSharedValue(1);
  const leanX = useSharedValue(0);
  const leanY = useSharedValue(0);
  const halo = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(float);
    float.value = 0;
    if (reduced || !foreground || !active || real !== 'idle') return;
    const ease = Easing.inOut(Easing.sin);
    float.value = withRepeat(withSequence(withTiming(-size * 0.03, { duration: 1500, easing: ease }), withTiming(0, { duration: 1500, easing: ease })), -1);
  }, [reduced, foreground, active, real, size, float]);

  // A steady glow while it works; a pulse while it needs you.
  useEffect(() => {
    cancelAnimation(halo);
    halo.value = real === 'run' ? 0.35 : 0;
    if (reduced || !foreground || !active || real !== 'waiting') return;
    halo.value = withRepeat(withSequence(withTiming(1, { duration: 900 }), withTiming(0.2, { duration: 900 })), -1);
  }, [reduced, foreground, active, real, halo]);

  const poke = () => {
    const next = tapReaction(taps.current, Date.now(), loopMs);
    taps.current = next.recent;
    setReaction(next.reaction);
    haptic.light();
    sound.tap();
    if (!reduced) squash.value = withSequence(withTiming(0.88, { duration: 90 }), withSpring(1, spring.snappy));
    onTap?.();
  };

  const leanTo = (dx: number, dy: number) => {
    if (reduced) return;
    const cap = size * 0.12;
    leanX.value = Math.max(-cap, Math.min(cap, dx * 0.25));
    leanY.value = Math.max(-cap, Math.min(cap, dy * 0.25));
  };
  const settle = () => {
    leanX.value = withSpring(0, spring.soft);
    leanY.value = withSpring(0, spring.soft);
  };

  // A tap that wanders isn't a tap: a short drag never opens anything.
  const tap = Gesture.Tap().enabled(active).maxDistance(10).runOnJS(true).onEnd((_e, success) => { if (success) poke(); });

  let gesture;
  if (onHoldStart) {
    // Hold-to-talk follows the finger the whole time, so sliding away can cancel it (a long press would give up
    // after a few pixels, and its end would look like a let-go).
    const talk = Gesture.Pan().enabled(active).activateAfterLongPress(HOLD_MS).runOnJS(true)
      .onStart(() => { haptic.selection(); onHoldStart(); })
      .onUpdate((e) => leanTo(e.translationX, e.translationY))
      .onEnd((e, success) => { onHoldEnd?.(holdCancelled(success, e.translationX, e.translationY)); })
      .onFinalize(settle);
    gesture = Gesture.Exclusive(talk, tap);
  } else {
    const hold = Gesture.LongPress().enabled(active).minDuration(HOLD_MS).runOnJS(true)
      .onStart(() => { haptic.selection(); setReaction(holdReaction()); })
      .onEnd(() => setReaction(null));
    const lean = Gesture.Pan().enabled(active && draggable).runOnJS(true).minDistance(6)
      .onUpdate((e) => leanTo(e.translationX, e.translationY))
      .onFinalize(settle);
    gesture = Gesture.Simultaneous(lean, Gesture.Exclusive(hold, tap));
  }

  const body = useAnimatedStyle(() => ({
    transform: [
      { translateX: leanX.value },
      { translateY: float.value + leanY.value },
      { rotate: `${(leanX.value / Math.max(1, size * 0.12)) * LEAN_MAX_DEG}deg` },
      { scaleX: 2 - squash.value },
      { scaleY: squash.value },
    ],
  }));
  const haloStyle = useAnimatedStyle(() => ({ opacity: halo.value * 0.6, transform: [{ scale: 1 + halo.value * 0.15 }] }));

  const shown = shownState(real, reaction, Date.now());
  return (
    <GestureDetector gesture={gesture}>
      <View accessible={active} aria-hidden={!active} accessibilityRole={active ? 'button' : undefined} accessibilityLabel={active ? accessibilityLabel ?? `${server.bot.title}. Tap to poke` : undefined}
        // Screen readers activate with a double tap, which never reaches the gesture handler.
        accessibilityActions={[{ name: 'activate' }]} onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'activate') poke(); }}
        style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Animated.View pointerEvents="none" style={[{
          position: 'absolute', width: size * 0.9, height: size * 0.9, borderRadius: size, backgroundColor: color,
        }, haloStyle]} />
        <Animated.View style={body}>
          <AgentFace server={server} size={size} glow={glow} bare={bare} status={status} animated
            motionPaused={!active} petState={pet ? shown : undefined} mood={!pet && reaction ? 'happy' : undefined} />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}
