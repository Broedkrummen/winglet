import { memo, useEffect } from 'react';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { spring, useReducedMotion } from '../lib/motion';
import type { Server } from '../lib/types';
import { LivePet } from './LivePet';

/** Where the landing's pet sits: its centre from the top of the landing, and its size. */
export type DockPetFrame = { centerY: number; size: number };

/** How big the pet is once it sits on the message box. */
const PERCHED = 40;

/** One selected character settles from its measured dock slot onto the message box. */
export const ChatPet = memo(function ChatPet({ server, active, width, composerHeight, dockHeight, dockOffset = 0, frame, sent, perched = false }: {
  server: Server; active: boolean; width: number; composerHeight: number; dockHeight: number; dockOffset?: number; frame: DockPetFrame; sent: number; perched?: boolean;
}) {
  const reduced = useReducedMotion();
  const progress = useSharedValue(perched ? 1 : 0);
  const opacity = useSharedValue(perched ? 1 : 0);
  const hop = useSharedValue(0);
  useEffect(() => {
    progress.value = reduced ? (active ? 1 : 0) : withSpring(active ? 1 : 0, spring.soft);
    opacity.value = withTiming(active ? 1 : 0, { duration: reduced ? 0 : active ? 80 : 180 });
  }, [active, reduced, progress, opacity]);
  useEffect(() => {
    if (!sent || reduced) return;
    hop.value = withSequence(withTiming(-10, { duration: 100 }), withSpring(0, spring.snappy));
  }, [sent, reduced, hop]);
  const rise = 8 + dockOffset + dockHeight - frame.centerY - frame.size / 2;
  const destinationX = Math.max(10, (width - 820) / 2) + 36;
  const pose = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateX: (destinationX - width / 2) * progress.value },
      { translateY: (rise + (frame.size - PERCHED) / 2 + 6) * progress.value + hop.value },
      { scale: 1 + (PERCHED / frame.size - 1) * progress.value }],
  }));
  return <Animated.View pointerEvents={active ? 'auto' : 'none'} aria-hidden={!active} accessibilityElementsHidden={!active}
    style={[{ position: 'absolute', left: (width - frame.size) / 2, bottom: composerHeight + rise, width: frame.size, height: frame.size, zIndex: 4 }, pose]}>
    <LivePet server={server} size={frame.size} bare draggable={false} active={active} />
  </Animated.View>;
});
