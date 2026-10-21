import { memo, useEffect } from 'react';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { spring, useReducedMotion } from '../lib/motion';
import type { Server } from '../lib/types';
import type { DockPetFrame } from './BotCarousel';
import { LivePet } from './LivePet';

/** One selected character settles from its measured dock slot onto the message box. */
export const ChatPet = memo(function ChatPet({ server, active, width, composerHeight, dockHeight, frame, sent, perched = false }: {
  server: Server; active: boolean; width: number; composerHeight: number; dockHeight: number; frame: DockPetFrame; sent: number; perched?: boolean;
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
  const rise = 8 + dockHeight - frame.centerY - frame.size / 2;
  const destinationX = Math.max(10, (width - 820) / 2) + 42;
  const pose = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateX: (destinationX - width / 2) * progress.value },
      { translateY: (rise + (frame.size - 52) / 2 + 6) * progress.value + hop.value },
      { scale: 1 + (52 / frame.size - 1) * progress.value }],
  }));
  return <Animated.View pointerEvents={active ? 'auto' : 'none'} aria-hidden={!active} accessibilityElementsHidden={!active}
    style={[{ position: 'absolute', left: (width - frame.size) / 2, bottom: composerHeight + rise, width: frame.size, height: frame.size, zIndex: 4 }, pose]}>
    <LivePet server={server} size={frame.size} bare draggable={false} active={active} />
  </Animated.View>;
});
