import { ScrollView, Text, View } from 'react-native';
import type { ChatFilter } from '../lib/chatActivity';
import { makeStyles, useTheme } from '../lib/themeContext';
import { Tap } from './ui';

/** All / Running / Needs you (/ Archived) as a row of quiet tabs; the chosen one sits on a raised background. */
export function ChatFilters({ value, onChange, counts, archived }: {
  value: ChatFilter | 'archived'; onChange: (value: ChatFilter | 'archived') => void;
  counts: { running: number; pending: number }; archived?: number;
}) {
  const t = useTheme();
  const s = useStyles();
  const options: { value: ChatFilter | 'archived'; label: string; count?: number; tone?: 'warning' }[] = [
    { value: 'all', label: 'All' }, { value: 'running', label: 'Running', count: counts.running },
    { value: 'needs-you', label: 'Needs you', count: counts.pending, tone: 'warning' },
    ...(archived === undefined ? [] : [{ value: 'archived' as const, label: 'Archived', count: archived }]),
  ];
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.scroll} contentContainerStyle={s.filters}
    keyboardShouldPersistTaps="handled" accessibilityRole="tablist" accessibilityLabel="Filter chats">
    {options.map((option) => {
      const on = value === option.value;
      return <Tap key={option.value} feedback="selection" scaleTo={0.94} accessibilityRole="tab"
        accessibilityLabel={`${option.label} chats${option.count ? `, ${option.count}` : ''}`}
        aria-selected={on}
        accessibilityState={{ selected: on }} onPress={() => onChange(option.value)} style={s.target}>
        <View style={[s.pill, on && s.selected]}>
          <Text style={[s.label, on && { color: t.colors.text }]}>{option.label}</Text>
          {option.count ? <Text style={[s.count, { color: option.tone === 'warning' ? t.colors.warning : t.colors.textTertiary }]}>{option.count}</Text> : null}
        </View>
      </Tap>;
    })}
  </ScrollView>;
}

const useStyles = makeStyles((t) => ({
  scroll: { flexGrow: 0, flexShrink: 0 },
  filters: { gap: 2, paddingHorizontal: 2, alignItems: 'center' },
  // The tab is drawn smaller than its 44pt touch target.
  target: { minHeight: 44, justifyContent: 'center' },
  pill: { minHeight: 30, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: t.radius.sm },
  selected: { backgroundColor: t.colors.surfaceHigh },
  label: { ...t.type.footnote, fontFamily: t.fonts.medium, color: t.colors.textSecondary },
  count: { ...t.type.caption, fontVariant: ['tabular-nums'] },
}));
