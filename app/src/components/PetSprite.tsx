import { Image } from 'expo-image';
import { useEffect } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useReducedMotion } from '../lib/motion';
import { petBox, petFrames, PET_STATES, type PetState } from '../lib/pets';
import type { PetSheet } from '../lib/types';

type Props = {
  sheet: PetSheet;
  /** The sheet's full address (a signed link on the bot's server). */
  uri: string;
  height: number;
  state: PetState;
  /** Show the state's first frame only. Always so when motion is reduced. */
  still?: boolean;
  style?: StyleProp<ViewStyle>;
};

/**
 * One pet from its spritesheet: a window one frame big, with the whole sheet moved behind it. Frames
 * step on the UI thread, so a pet animating never re-renders the screen it sits on.
 */
export function PetSprite({ sheet, uri, height, state, still, style }: Props) {
  const reduced = useReducedMotion();
  const { row, count } = petFrames(sheet, state);
  const box = petBox(sheet, height);
  const frame = useSharedValue(0);
  const animate = !still && !reduced && count > 1;

  useEffect(() => {
    frame.value = 0;
    if (!animate) return;
    let i = 0;
    const id = setInterval(() => {
      i = (i + 1) % count;
      frame.value = i;
    }, sheet.loop_ms / count);
    return () => clearInterval(id);
  }, [animate, row, count, sheet.loop_ms, frame]);

  const { width: w, height: h } = box;
  const move = useAnimatedStyle(() => ({ transform: [{ translateX: -frame.value * w }, { translateY: -row * h }] }));
  const label = PET_STATES.find((x) => x.state === state)?.label.toLowerCase() ?? state;

  return (
    <View style={[{ width: w, height: h, overflow: 'hidden' }, style]} accessibilityRole="image" accessibilityLabel={`${sheet.name}, ${label}`}>
      <Animated.View style={[{ width: w * sheet.columns, height: h * sheet.rows }, move]}>
        <Image source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="fill" cachePolicy="disk" transition={0}
          accessibilityIgnoresInvertColors />
      </Animated.View>
    </View>
  );
}
