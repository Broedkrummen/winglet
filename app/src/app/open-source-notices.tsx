import { useState } from 'react';
import { Text, View } from 'react-native';
import { Markdown } from '../components/Markdown';
import { Screen } from '../components/Screen';
import { Card, Footnote, Tap } from '../components/ui';
import notices from '../generated/third-party-notices.json';
import { makeStyles, useTheme } from '../lib/themeContext';

/** Complete attribution text is bundled locally, including in the Android app. */
export default function OpenSourceNoticesScreen() {
  const s = useStyles();
  const t = useTheme();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  return (
    <Screen title="Open-source notices">
      <View style={s.list}>
        {notices.map(notice => {
          const open = expanded.has(notice.file);
          return (
            <Card key={notice.file} style={s.card}>
              <Tap accessibilityLabel={notice.title} accessibilityState={{ expanded: open }} aria-expanded={open} feedback="selection"
                onPress={() => setExpanded(previous => { const next = new Set(previous); if (open) next.delete(notice.file); else next.add(notice.file); return next; })}
                style={({ hovered }) => [s.heading, hovered && { backgroundColor: t.colors.pressed }]}>
                <Text style={s.title}>{notice.title}</Text>
                <Text style={s.action}>{open ? 'Hide' : 'Read'}</Text>
              </Tap>
              {open ? <View style={s.body}><Markdown text={notice.text} selectable /></View> : null}
            </Card>
          );
        })}
      </View>
      <Footnote>Full licenses and attribution are available offline.</Footnote>
    </Screen>
  );
}

const useStyles = makeStyles(t => ({
  list: { gap: 12, marginTop: 24 },
  card: { padding: 0, overflow: 'hidden' },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 16, padding: 16, minHeight: 56 },
  title: { ...t.type.bodyStrong, color: t.colors.text, flex: 1, minWidth: 0 },
  action: { ...t.type.caption, color: t.colors.textSecondary },
  body: { paddingHorizontal: 16, paddingBottom: 16 },
}));
