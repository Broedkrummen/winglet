import { ScrollView, Text } from 'react-native';
import type { ChatFilter } from '../lib/chatActivity';
import { makeStyles, useTheme } from '../lib/themeContext';
import { Tap } from './ui';

export function ChatFilters({ value, onChange, counts, archived }: {
  value: ChatFilter | 'archived'; onChange: (value: ChatFilter | 'archived') => void;
  counts: { running: number; pending: number }; archived?: number;
}) {
  const t = useTheme();
  const s = useStyles();
  const options: { value: ChatFilter | 'archived'; label: string; count?: number }[] = [
    { value: 'all', label: 'All' }, { value: 'running', label: 'Running', count: counts.running },
    { value: 'needs-you', label: 'Needs you', count: counts.pending },
    ...(archived === undefined ? [] : [{ value: 'archived' as const, label: 'Archived', count: archived }]),
  ];
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.scroll} contentContainerStyle={s.filters}
    keyboardShouldPersistTaps="handled" accessibilityRole="tablist" accessibilityLabel="Filter chats">
    {options.map((option) => <Tap key={option.value} feedback="selection" accessibilityRole="tab"
      accessibilityLabel={`${option.label} chats${option.count ? `, ${option.count}` : ''}`}
      aria-selected={value === option.value}
      accessibilityState={{ selected: value === option.value }} onPress={() => onChange(option.value)}
      style={[s.filter, value === option.value && s.selected]}>
      <Text style={[s.label, value === option.value && { color: t.colors.onAccentSoft }]}>{option.label}</Text>
      {option.count ? <Text style={[s.count, value === option.value && { color: t.colors.onAccentSoft }]}>{option.count}</Text> : null}
    </Tap>)}
  </ScrollView>;
}

const useStyles = makeStyles((t) => ({
  scroll: { flexGrow: 0, flexShrink: 0 },
  filters: { gap: 4, paddingHorizontal: 4, paddingVertical: 4 },
  filter: { minHeight: 44, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 12 },
  selected: { backgroundColor: t.colors.accentSoft },
  label: { ...t.type.caption, color: t.colors.textSecondary, fontFamily: t.fonts.medium },
  count: { ...t.type.caption, color: t.colors.textTertiary, fontSize: 11 },
}));
