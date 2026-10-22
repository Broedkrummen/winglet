import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator, Platform, Pressable, Switch, Text, TextInput, View,
  type AccessibilityRole, type PressableProps, type StyleProp, type TextInputProps, type ViewStyle,
} from 'react-native';
import Animated, {
  cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withSpring, withTiming,
} from 'react-native-reanimated';
import { haptic } from '../lib/haptics';
import { FIXED } from '../lib/theme';
import { spring, useReducedMotion } from '../lib/motion';
import { makeStyles, useTheme } from '../lib/themeContext';
import { ChevronRight, CircleAlert, RotateCcw, Search, X } from './icons';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type TapProps = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle> | ((state: { pressed: boolean; hovered?: boolean }) => StyleProp<ViewStyle>);
  /** How much it shrinks while pressed. */
  scaleTo?: number;
  feedback?: 'selection' | 'light' | 'none';
  children?: ReactNode;
};

/** A pressable that gives way slightly under the finger. Acts on release, so a touch can slide off. */
export function Tap({ style, scaleTo = 0.97, feedback = 'none', onPressIn, onPressOut, onPress, children, ...rest }: TapProps) {
  const reduced = useReducedMotion();
  const scale = useSharedValue(1);
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedPressable
      accessibilityRole="button"
      {...rest}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPressIn={(e) => {
        setPressed(true);
        if (!reduced) scale.value = withSpring(scaleTo, spring.snappy);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        setPressed(false);
        scale.value = reduced ? 1 : withSpring(1, spring.snappy);
        onPressOut?.(e);
      }}
      onPress={(e) => {
        if (feedback === 'selection') haptic.selection();
        else if (feedback === 'light') haptic.light();
        onPress?.(e);
      }}
      style={[typeof style === 'function' ? style({ pressed, hovered }) : style, animated]}
    >
      {children}
    </AnimatedPressable>
  );
}

type ButtonProps = {
  title: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'tonal' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  feedback?: 'selection' | 'light' | 'none';
};

export function Button({ title, onPress, variant = 'primary', size = 'md', icon, loading, disabled, style, accessibilityLabel, feedback = 'selection' }: ButtonProps) {
  const t = useTheme();
  const s = useStyles();
  const c = t.colors;
  const height = size === 'lg' ? 54 : size === 'sm' ? 38 : 46;
  const fg = { primary: c.onAccent, secondary: c.text, tonal: c.onAccentSoft, ghost: c.accent, danger: c.danger }[variant];
  const bg = { primary: 'transparent', secondary: c.surfaceSunken, tonal: c.accentSoft, ghost: 'transparent', danger: c.dangerSoft }[variant];
  const inner = (
    <>
      {loading ? <ActivityIndicator color={fg} /> : icon}
      {title ? <Text style={[s.buttonText, { color: fg }, size === 'sm' && { fontSize: 14 }, size === 'lg' && { fontSize: 16.5 }]} numberOfLines={1}>{title}</Text> : null}
    </>
  );
  return (
    <Tap
      feedback={feedback}
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      onPress={onPress}
      disabled={disabled || loading}
      style={[s.buttonShell, { minHeight: height, opacity: disabled ? 0.45 : 1, backgroundColor: bg }, style]}
    >
      {variant === 'primary' ? (
        <LinearGradient colors={[c.accentFillLight, c.accentFill]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          style={[s.buttonInner, { minHeight: height }, size === 'sm' && { paddingHorizontal: 14 }]}>
          {inner}
        </LinearGradient>
      ) : (
        <View style={[s.buttonInner, { minHeight: height }, size === 'sm' && { paddingHorizontal: 14 }]}>{inner}</View>
      )}
    </Tap>
  );
}

export function IconButton({ children, onPress, label, style, variant = 'plain', size = 40, badge }: {
  children: ReactNode; onPress?: PressableProps['onPress']; label: string; style?: StyleProp<ViewStyle>;
  variant?: 'plain' | 'filled' | 'tonal'; size?: number; badge?: number;
}) {
  const t = useTheme();
  const bg = variant === 'filled' ? t.colors.surfaceSunken : variant === 'tonal' ? t.colors.accentSoft : 'transparent';
  // Small visual buttons still get a 48dp touch target.
  const slop = Math.max(0, (48 - size) / 2);
  return (
    <Tap
      feedback="selection"
      accessibilityLabel={label}
      hitSlop={slop}
      onPress={onPress}
      scaleTo={0.92}
      style={({ pressed, hovered }) => [{
        width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center',
        backgroundColor: pressed || hovered ? t.colors.pressed : bg,
      }, style]}
    >
      {children}
      {badge ? <Badge count={badge} style={{ position: 'absolute', top: -3, right: -3 }} /> : null}
    </Tap>
  );
}

export function Badge({ count, style, dot }: { count: number; style?: StyleProp<ViewStyle>; dot?: boolean }) {
  const s = useStyles();
  const t = useTheme();
  if (!count) return null;
  if (dot) return <View style={[s.dot, { backgroundColor: t.colors.danger }, style]} />;
  return (
    <View style={[s.badge, style]} accessibilityLabel={`${count} waiting`}>
      <Text style={s.badgeText}>{count > 99 ? '99+' : count}</Text>
    </View>
  );
}

export function SectionHeader({ title, right, style }: { title: string; right?: ReactNode; style?: StyleProp<ViewStyle> }) {
  const s = useStyles();
  return (
    <View style={[s.section, style]} accessibilityRole="header">
      <Text style={s.sectionText}>{title}</Text>
      {right}
    </View>
  );
}

/** A grouped list, like iOS settings: rows inside one rounded card, divided by hairlines. */
export function ListGroup({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const s = useStyles();
  const items = (Array.isArray(children) ? children.flat() : [children]).filter(Boolean);
  return (
    <View style={[s.group, style]}>
      {items.map((child, i) => (
        <View key={i}>
          {i > 0 ? <View style={s.hairline} /> : null}
          {child}
        </View>
      ))}
    </View>
  );
}

export function ListRow({ icon, iconColor, title, subtitle, value, right, onPress, chevron = !!onPress, destructive, accessibilityRole, disabled }: {
  icon?: ReactNode; iconColor?: string; title: string; subtitle?: string; value?: string; right?: ReactNode;
  onPress?: () => void; chevron?: boolean; destructive?: boolean; accessibilityRole?: AccessibilityRole; disabled?: boolean;
}) {
  const t = useTheme();
  const s = useStyles();
  const body = (
    <>
      {icon ? <View style={[s.rowIcon, { backgroundColor: iconColor ? `${iconColor}22` : t.colors.accentSoft }]}>{icon}</View> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[s.rowTitle, destructive && { color: t.colors.danger }]}>{title}</Text>
        {subtitle ? <Text style={s.rowSubtitle}>{subtitle}</Text> : null}
      </View>
      {value ? <Text style={s.rowValue} numberOfLines={1}>{value}</Text> : null}
      {/* A switch or button on a row you can also tap: using it mustn't tap the row (on the web its click bubbles). */}
      {right && onPress ? <Pressable accessible={false} onPress={() => undefined}>{right}</Pressable> : right}
      {chevron ? <ChevronRight size={18} color={t.colors.textTertiary} /> : null}
    </>
  );
  if (!onPress) return <View style={s.row}>{body}</View>;
  return (
    <Tap feedback="selection" scaleTo={0.99} disabled={disabled} accessibilityRole={accessibilityRole ?? 'button'} accessibilityLabel={title}
      onPress={onPress} style={({ pressed, hovered }) => [s.row, (pressed || hovered) && { backgroundColor: t.colors.pressed }, disabled && { opacity: 0.5 }]}>
      {body}
    </Tap>
  );
}

export function Toggle({ value, onValueChange, label }: { value: boolean; onValueChange: (v: boolean) => void; label: string }) {
  const t = useTheme();
  return (
    <Switch
      accessibilityLabel={label}
      value={value}
      onValueChange={(v) => {
        haptic.selection();
        onValueChange(v);
      }}
      trackColor={{ false: t.colors.borderStrong, true: t.colors.accentFill }}
      thumbColor={FIXED.white}
      {...(Platform.OS === 'web' ? ({ activeThumbColor: FIXED.white } as object) : {})}
    />
  );
}

/** A row of options with a sliding highlight. */
export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: { value: T; label: string; icon?: ReactNode }[]; value: T; onChange: (v: T) => void; label: string;
}) {
  const t = useTheme();
  const s = useStyles();
  const [width, setWidth] = useState(0);
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const x = useSharedValue(0);
  const reduced = useReducedMotion();
  const each = width ? (width - 8) / options.length : 0;
  useEffect(() => {
    x.value = reduced ? index * each : withSpring(index * each, spring.snappy);
  }, [index, each, reduced, x]);
  const pill = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={s.segmented} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {each ? <Animated.View style={[s.segmentPill, { width: each }, pill]} /> : null}
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={o.label}
            style={s.segment} onPress={() => { if (!on) { haptic.selection(); onChange(o.value); } }}>
            {o.icon}
            <Text style={[s.segmentText, { color: on ? t.colors.text : t.colors.textSecondary }]} numberOfLines={1}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chip({ label, icon, selected, onPress, accessibilityLabel }: {
  label: string; icon?: ReactNode; selected?: boolean; onPress?: () => void; accessibilityLabel?: string;
}) {
  const t = useTheme();
  const s = useStyles();
  return (
    <Tap feedback="selection" onPress={onPress} accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      style={({ hovered }) => [s.chip, selected ? { backgroundColor: t.colors.accentSoft, borderColor: 'transparent' } : hovered && { backgroundColor: t.colors.pressed }]}>
      {icon}
      <Text style={[s.chipText, { color: selected ? t.colors.onAccentSoft : t.colors.text }]} numberOfLines={1}>{label}</Text>
    </Tap>
  );
}

export function Field(props: TextInputProps & { label?: string; hint?: string }) {
  const t = useTheme();
  const s = useStyles();
  const [focus, setFocus] = useState(false);
  const { label, hint, style, ...rest } = props;
  return (
    <View style={{ gap: 8 }}>
      {label ? <Text style={s.fieldLabel}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={t.colors.textTertiary}
        accessibilityLabel={label}
        {...rest}
        onFocus={(e) => { setFocus(true); rest.onFocus?.(e); }}
        onBlur={(e) => { setFocus(false); rest.onBlur?.(e); }}
        style={[s.input, focus && { borderColor: t.colors.accent }, style]}
      />
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
    </View>
  );
}

/** A placeholder block that shimmers while content loads (still when motion is reduced). */
export function Skeleton({ width, height = 14, radius = 8, style }: { width?: number | `${number}%`; height?: number; radius?: number; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const reduced = useReducedMotion();
  const o = useSharedValue(0.55);
  useEffect(() => {
    if (reduced) return;
    o.value = withRepeat(withSequence(withTiming(1, { duration: 700 }), withTiming(0.55, { duration: 700 })), -1);
    return () => cancelAnimation(o);
  }, [reduced, o]);
  const anim = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[{ width: width ?? '100%', height, borderRadius: radius, backgroundColor: t.colors.surfaceSunken }, anim, style]} />;
}

export function Card({ children, style, onPress, accessibilityLabel }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; accessibilityLabel?: string }) {
  const s = useStyles();
  const t = useTheme();
  if (!onPress) return <View style={[s.card, style]} accessibilityLabel={accessibilityLabel}>{children}</View>;
  return (
    <Tap feedback="selection" scaleTo={0.98} onPress={onPress} accessibilityLabel={accessibilityLabel}
      style={({ hovered }) => [s.card, hovered && { borderColor: t.colors.borderStrong }, style]}>
      {children}
    </Tap>
  );
}

/** A screen whose first load failed: what went wrong and a way to try again, instead of a skeleton forever. */
export function LoadError({ message, onRetry, style }: { message: string; onRetry: () => unknown; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const s = useStyles();
  return (
    <View style={[s.loadError, style]} accessibilityLiveRegion="polite">
      <CircleAlert size={22} color={t.colors.danger} />
      <Text style={s.loadErrorText}>{message || "Couldn't load this."}</Text>
      <Button title="Try again" size="sm" variant="secondary" icon={<RotateCcw size={15} color={t.colors.text} />} onPress={() => { onRetry(); }} />
    </View>
  );
}

/**
 * A button for something that can't be undone: the first tap arms it ("Tap again to …"), the second does it.
 * It disarms itself after a few seconds.
 */
export function ConfirmButton({ title, confirmTitle, onConfirm, icon, size = 'md', style, accessibilityLabel, loading }: {
  title: string; confirmTitle?: string; onConfirm: () => unknown; icon?: ReactNode; size?: 'sm' | 'md' | 'lg';
  style?: StyleProp<ViewStyle>; accessibilityLabel?: string; loading?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const press = () => {
    if (timer.current) clearTimeout(timer.current);
    if (!armed) {
      haptic.light();
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    setArmed(false);
    onConfirm();
  };
  const label = armed ? confirmTitle ?? `Tap again to ${title.charAt(0).toLowerCase()}${title.slice(1)}` : title;
  return (
    <Button title={label} variant={armed ? 'danger' : 'ghost'} size={size} icon={icon} style={style} loading={loading} onPress={press}
      accessibilityLabel={armed ? `Confirm: ${accessibilityLabel ?? title}` : accessibilityLabel ?? title} feedback="none" />
  );
}

/** A search box with a clear button, the same on every screen. */
export function SearchField({ value, onChangeText, placeholder, style }: {
  value: string; onChangeText: (text: string) => void; placeholder: string; style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const s = useStyles();
  return (
    <View style={[s.search, style]}>
      <Search size={16} color={t.colors.textTertiary} />
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={t.colors.textTertiary}
        style={s.searchInput} autoCapitalize="none" autoCorrect={false} accessibilityLabel={placeholder} returnKeyType="search" />
      {value ? (
        <Pressable onPress={() => onChangeText('')} accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={10} style={s.searchClear}>
          <X size={14} color={t.colors.bg} />
        </Pressable>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  loadError: { alignItems: 'center', gap: 10, paddingVertical: 28, paddingHorizontal: 20 },
  loadErrorText: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center', maxWidth: 360 },
  search: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, height: 46, borderRadius: t.radius.pill,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
  },
  searchInput: { flex: 1, ...t.type.body, color: t.colors.text, ...({ outlineStyle: 'none' } as object) },
  searchClear: { width: 20, height: 20, borderRadius: 10, backgroundColor: t.colors.textTertiary, alignItems: 'center', justifyContent: 'center' },
  buttonShell: { borderRadius: t.radius.pill, overflow: 'hidden' },
  buttonInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 20 },
  buttonText: { fontFamily: t.fonts.semibold, fontSize: 15.5 },
  badge: {
    minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, backgroundColor: t.colors.danger,
    alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: t.colors.bg,
  },
  badgeText: { color: t.colors.onDanger, fontFamily: t.fonts.bold, fontSize: 11 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  section: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, paddingTop: 22, paddingBottom: 10 },
  sectionText: { ...t.type.heading, color: t.colors.text },
  group: { backgroundColor: t.colors.surface, borderRadius: t.radius.lg, borderWidth: 1, borderColor: t.colors.border, overflow: 'hidden' },
  hairline: { height: 1, backgroundColor: t.colors.border, marginLeft: 60 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 13, minHeight: 56 },
  rowIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { ...t.type.body, fontFamily: t.fonts.medium, color: t.colors.text },
  rowSubtitle: { ...t.type.callout, color: t.colors.textSecondary, marginTop: 1 },
  rowValue: { ...t.type.callout, color: t.colors.textSecondary, maxWidth: 160 },
  segmented: { flexDirection: 'row', backgroundColor: t.colors.surfaceSunken, borderRadius: t.radius.pill, padding: 4 },
  segmentPill: {
    position: 'absolute', top: 4, bottom: 4, left: 4, borderRadius: t.radius.pill, backgroundColor: t.colors.surfaceHigh,
    borderWidth: 1, borderColor: t.colors.border,
    shadowColor: t.colors.shadow, shadowOpacity: t.scheme === 'light' ? 0.08 : 0, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
  },
  segment: { flex: 1, minHeight: 40, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  segmentText: { fontFamily: t.fonts.semibold, fontSize: 14 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 38, paddingHorizontal: 14, borderRadius: t.radius.pill,
    borderWidth: 1, borderColor: t.colors.border, backgroundColor: t.colors.surface, maxWidth: '100%',
  },
  chipText: { fontFamily: t.fonts.medium, fontSize: 14, flexShrink: 1 },
  fieldLabel: { ...t.type.label, color: t.colors.textSecondary },
  hint: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textSecondary },
  input: {
    backgroundColor: t.colors.surfaceSunken, color: t.colors.text, fontFamily: t.fonts.medium, fontSize: 16, borderRadius: t.radius.md,
    paddingHorizontal: 16, paddingVertical: 14, borderWidth: 1, borderColor: 'transparent',
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  card: { backgroundColor: t.colors.surface, borderRadius: t.radius.lg, borderWidth: 1, borderColor: t.colors.border, padding: 16 },
}));
