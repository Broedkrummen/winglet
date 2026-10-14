import { LinearGradient } from 'expo-linear-gradient';
import { useEffect } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import { useReducedMotion } from '../lib/motion';
import { avatarColor, hashText } from '../lib/pets';
import { useTheme } from '../lib/themeContext';
import { AVATAR, BOT_COLORS } from '../lib/theme';

/** What the agent is up to, as its face shows it. */
export type Mood = 'idle' | 'working' | 'waiting' | 'happy' | 'offline';

const hash = hashText;

/** The colour a bot is made with, from its name. A bot with a pet takes the pet's instead (see AgentFace). */
export function botColor(name: string): string {
  return avatarColor(BOT_COLORS, name);
}

export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(amount >= 0 ? v + (255 - v) * amount : v * (1 + amount))));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => ch(v).toString(16).padStart(2, '0')).join('')}`;
}

type Props = {
  name: string;
  size?: number;
  mood?: Mood;
  /** Breathe, blink and react. Off for small list avatars; always off when motion is reduced. */
  animated?: boolean;
  /** A soft halo in the bot's colour, for hero placements. */
  glow?: boolean;
  status?: 'online' | 'offline' | 'connecting' | 'busy';
  shape?: 'circle' | 'squircle';
  style?: StyleProp<ViewStyle>;
};

/**
 * Each bot's face: a glossy orb in its own colour, with eyes and a smile that are the same every
 * time for the same name. It breathes and blinks when idle, bobs while working, looks up when it's
 * waiting for you, and closes its eyes when it can't be reached.
 */
export function BotAvatar({ name, size = 40, mood = 'idle', animated = false, glow, status, shape = 'circle', style }: Props) {
  const t = useTheme();
  const reduced = useReducedMotion();
  const live = animated && !reduced && mood !== 'offline';
  const h = hash(name || 'hermes');
  const color = mood === 'offline' ? AVATAR.offline : BOT_COLORS[h % BOT_COLORS.length];
  const eyeStyle = (h >> 4) % 3; // 0 tall, 1 round, 2 wide
  const mouthStyle = (h >> 7) % 3; // 0 smile, 1 grin, 2 small
  const cheeks = ((h >> 9) & 1) === 1;
  const S = size;
  const radius = shape === 'squircle' ? S * 0.32 : S / 2;
  const ink = AVATAR.ink;

  const breath = useSharedValue(1);
  const bob = useSharedValue(0);
  const lookX = useSharedValue(0);
  const blink = useSharedValue(1);
  const halo = useSharedValue(0.55);

  useEffect(() => {
    [breath, bob, lookX, blink, halo].forEach(cancelAnimation);
    breath.value = 1; bob.value = 0; lookX.value = 0; blink.value = 1; halo.value = 0.55;
    if (!live) return;
    const ease = Easing.inOut(Easing.sin);
    breath.value = withRepeat(withSequence(withTiming(1.035, { duration: 1400, easing: ease }), withTiming(1, { duration: 1400, easing: ease })), -1);
    blink.value = withRepeat(withSequence(withDelay(3400, withTiming(0.12, { duration: 80 })), withTiming(1, { duration: 120 })), -1);
    if (mood === 'working') {
      bob.value = withRepeat(withSequence(withTiming(-S * 0.025, { duration: 700, easing: ease }), withTiming(0, { duration: 700, easing: ease })), -1);
      lookX.value = withRepeat(withSequence(withTiming(S * 0.03, { duration: 1200, easing: ease }), withTiming(-S * 0.03, { duration: 1200, easing: ease })), -1, true);
      halo.value = withRepeat(withSequence(withTiming(0.9, { duration: 700 }), withTiming(0.45, { duration: 700 })), -1);
    } else if (mood === 'waiting') {
      // A soft nudge now and then, not a bounce: it's asking, not alarmed.
      bob.value = withRepeat(withSequence(withDelay(2200, withTiming(-S * 0.04, { duration: 260, easing: ease })), withTiming(0, { duration: 360, easing: ease })), -1);
      halo.value = withRepeat(withSequence(withTiming(0.95, { duration: 900 }), withTiming(0.5, { duration: 900 })), -1);
    } else if (mood === 'happy') {
      bob.value = withSequence(withTiming(-S * 0.06, { duration: 220, easing: ease }), withTiming(0, { duration: 380, easing: ease }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, mood, S]);

  const body = useAnimatedStyle(() => ({ transform: [{ translateY: bob.value }, { scale: breath.value }] }));
  const eyes = useAnimatedStyle(() => ({ transform: [{ translateX: lookX.value }, { scaleY: blink.value }] }));
  const haloStyle = useAnimatedStyle(() => ({ opacity: halo.value }));

  const eyeW = eyeStyle === 2 ? S * 0.15 : eyeStyle === 1 ? S * 0.12 : S * 0.115;
  const eyeH = eyeStyle === 2 ? S * 0.12 : eyeStyle === 1 ? S * 0.12 : S * 0.17;
  const eyeY = S * (mood === 'waiting' ? 0.33 : 0.38);
  const eye = (cx: number) => {
    if (mood === 'offline') {
      return <View key={cx} style={{ position: 'absolute', left: cx - eyeW / 2, top: eyeY + eyeH / 2 - S * 0.015, width: eyeW, height: Math.max(1.5, S * 0.03), borderRadius: S, backgroundColor: ink }} />;
    }
    if (mood === 'happy') {
      return (
        <Svg key={cx} width={eyeW * 1.4} height={eyeH} style={{ position: 'absolute', left: cx - eyeW * 0.7, top: eyeY }} viewBox="0 0 14 10">
          <Path d="M2 8 Q7 0 12 8" stroke={ink} strokeWidth={2.6} strokeLinecap="round" fill="none" />
        </Svg>
      );
    }
    return (
      <View key={cx} style={{ position: 'absolute', left: cx - eyeW / 2, top: eyeY, width: eyeW, height: eyeH, borderRadius: S, backgroundColor: ink }}>
        {S >= 32 ? <View style={{ position: 'absolute', top: eyeH * 0.18, right: eyeW * 0.16, width: Math.max(2, eyeW * 0.34), height: Math.max(2, eyeW * 0.34), borderRadius: S, backgroundColor: AVATAR.catchlight }} /> : null}
      </View>
    );
  };

  const mouth = mood === 'offline' ? 'M42 66 Q50 64 58 66' : mood === 'working' ? 'M44 65 Q50 69 56 65'
    : mouthStyle === 0 ? 'M40 63 Q50 72 60 63' : mouthStyle === 1 ? 'M39 61 Q50 76 61 61 Z' : 'M44 64 Q50 69 56 64';

  const dot = status ? { online: t.colors.success, busy: t.colors.warning, connecting: t.colors.warning, offline: t.colors.textTertiary }[status] : null;
  const dotSize = Math.max(10, S * 0.3);

  return (
    <View style={[{ width: S, height: S }, style]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {glow ? (
        <Animated.View pointerEvents="none" style={[{
          position: 'absolute', left: S * 0.1, top: S * 0.1, width: S * 0.8, height: S * 0.8, borderRadius: S,
          backgroundColor: color, boxShadow: `0 0 ${S * 0.55}px ${S * 0.18}px ${color}`,
        } as ViewStyle, haloStyle]} />
      ) : null}
      <Animated.View style={[{ width: S, height: S }, live ? body : null]}>
        <LinearGradient
          colors={[shade(color, 0.32), color, shade(color, -0.18)]}
          locations={[0, 0.55, 1]}
          start={{ x: 0.15, y: 0 }}
          end={{ x: 0.85, y: 1 }}
          style={{ width: S, height: S, borderRadius: radius, overflow: 'hidden' }}
        >
          <View style={{ position: 'absolute', top: S * 0.07, left: S * 0.17, width: S * 0.42, height: S * 0.2, borderRadius: S, backgroundColor: AVATAR.shine, transform: [{ rotate: '-14deg' }] }} />
          {cheeks && S >= 28 && mood !== 'offline' ? (
            <>
              <View style={{ position: 'absolute', left: S * 0.16, top: S * 0.55, width: S * 0.14, height: S * 0.07, borderRadius: S, backgroundColor: AVATAR.cheek }} />
              <View style={{ position: 'absolute', right: S * 0.16, top: S * 0.55, width: S * 0.14, height: S * 0.07, borderRadius: S, backgroundColor: AVATAR.cheek }} />
            </>
          ) : null}
          <Animated.View style={[{ position: 'absolute', left: 0, top: 0, width: S, height: S }, live ? eyes : null]}>
            {eye(S * 0.36)}
            {eye(S * 0.64)}
          </Animated.View>
          <Svg width={S} height={S} viewBox="0 0 100 100" style={{ position: 'absolute' }}>
            <Path d={mouth} stroke={ink} strokeWidth={4.2} strokeLinecap="round" fill={mouth.endsWith('Z') ? ink : 'none'} />
          </Svg>
        </LinearGradient>
      </Animated.View>
      {dot ? (
        <View style={{ position: 'absolute', right: -1, bottom: -1, width: dotSize, height: dotSize, borderRadius: dotSize,
          backgroundColor: dot, borderWidth: Math.max(2, S * 0.07), borderColor: t.colors.bg }} />
      ) : null}
    </View>
  );
}

/** The human side of a conversation, in the compact layout. */
export function UserAvatar({ size = 40 }: { size?: number }) {
  const t = useTheme();
  return (
    <View style={{ width: size, height: size, borderRadius: size, backgroundColor: t.colors.surfaceSunken, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24">
        <Circle cx={12} cy={8} r={4.2} fill={t.colors.textSecondary} />
        <Path d="M4 20c1.2-4 4.4-6 8-6s6.8 2 8 6" fill={t.colors.textSecondary} />
      </Svg>
    </View>
  );
}
