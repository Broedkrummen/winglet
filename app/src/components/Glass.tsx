import { BlurView } from 'expo-blur';
import type { ReactNode, RefObject } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useReducedTransparency } from '../lib/motion';
import { useTheme } from '../lib/themeContext';

/**
 * The backing for floating chrome only (headers, the composer, sheets, toasts), never behind body text. It is
 * near-opaque on purpose: a hint of what scrolls underneath, never a tinted effect. Falls back to a solid surface when
 * transparency is reduced. On Android a real blur needs the content behind it wrapped in a BlurTargetView, passed
 * here as `target`.
 */
export function Glass({ children, style, target, intensity = 40, borderless }: {
  children?: ReactNode; style?: StyleProp<ViewStyle>; target?: RefObject<View | null>; intensity?: number; borderless?: boolean;
}) {
  const t = useTheme();
  const reduced = useReducedTransparency();
  const border = borderless ? null : { borderWidth: StyleSheet.hairlineWidth * 2, borderColor: t.colors.border };
  if (reduced || (Platform.OS === 'android' && !target)) {
    return <View style={[{ backgroundColor: t.colors.glassOpaque, overflow: 'hidden' }, border, style]}>{children}</View>;
  }
  if (Platform.OS === 'web') {
    const glass = { backgroundColor: t.colors.glass, backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' };
    return <View style={[glass as ViewStyle, { overflow: 'hidden' }, border, style]}>{children}</View>;
  }
  return (
    <View style={[{ overflow: 'hidden' }, border, style]}>
      <BlurView
        style={StyleSheet.absoluteFill}
        intensity={intensity}
        tint={t.scheme === 'dark' ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
        blurMethod="dimezisBlurViewSdk31Plus"
        blurTarget={target}
      />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: t.colors.glass }]} />
      {children}
    </View>
  );
}
