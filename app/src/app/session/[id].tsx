import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { ChevronDown, ChevronRight, TriangleAlert, Wrench } from '../../components/icons';
import { Markdown } from '../../components/Markdown';
import { Screen } from '../../components/Screen';
import { ListGroup, ListRow, SectionHeader, Skeleton, Tap } from '../../components/ui';
import { agoText } from '../../lib/agent';
import { spring, useReducedMotion } from '../../lib/motion';
import { api } from '../../lib/api';
import { sessionTitle, sourceLabel } from '../../lib/sessions';
import { useApp } from '../../lib/store';
import { makeStyles, useTheme } from '../../lib/themeContext';
import type { SessionMessage, SessionTranscript } from '../../lib/types';

/** One past conversation, read-only: what was asked, what the agent said, and the tools it used. */
export default function SessionScreen() {
  const t = useTheme();
  const s = useStyles();
  const reduced = useReducedMotion();
  const { id, server: serverId } = useLocalSearchParams<{ id: string; server?: string }>();
  const server = useApp((st) => serverId ? st.servers.find(x => x.id === serverId) : st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
  const [data, setData] = useState<SessionTranscript | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true; setData(null); setError('');
    if (!server || !id) return;
    api<SessionTranscript>(server, `/api/sessions/${encodeURIComponent(id)}`).then(d => { if (active) setData(d); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [server, id]);

  if (!server) return null;
  const session = data?.session;
  return (
    <Screen title={session ? sessionTitle(session) : 'Session'}>
      {session ? <>
        <SectionHeader title="Session" />
        <ListGroup>
          <ListRow title="Source" value={sourceLabel(session.source)} />
          {session.model ? <ListRow title="Model" value={session.model} /> : null}
          {session.started_at ? <ListRow title="Started" value={agoText(session.started_at)} /> : null}
        </ListGroup>
      </> : null}
      {error ? <Text style={s.error}>{error}</Text> : null}
      {!data && !error ? (
        <View style={{ gap: 12, marginTop: 18 }}>{[64, 120, 64, 160].map((h, i) => <Skeleton key={i} height={h} radius={t.radius.lg} />)}</View>
      ) : null}
      {data ? (
        <Animated.View entering={reduced ? undefined : FadeIn} style={{ gap: 12, marginTop: 18 }}>
          {data.truncated ? <Text style={s.note}>Showing the latest 500 messages.</Text> : null}
          {data.messages.map((m, i) => (
            <Animated.View key={`${m.id}-${i}`} entering={reduced || i > 10 ? undefined
              : FadeIn.duration(180)}>
              <Turn message={m} />
            </Animated.View>
          ))}
          {!data.messages.length ? <Text style={s.note}>No messages in this session.</Text> : null}
        </Animated.View>
      ) : null}
    </Screen>
  );
}

function Turn({ message }: { message: SessionMessage }) {
  const t = useTheme();
  const s = useStyles();
  const [open, setOpen] = useState(false);
  if (message.role === 'tool') {
    return (
      <Tap feedback="selection" onPress={() => setOpen((o) => !o)} accessibilityLabel={`${message.tool || 'Tool'} result. ${open ? 'Hide' : 'Show'}`}
        style={s.tool}>
        <View style={s.toolHead}>
          {open ? <ChevronDown size={14} color={t.colors.textTertiary} /> : <ChevronRight size={14} color={t.colors.textTertiary} />}
          <Text style={s.toolLabel}>{message.tool || 'Tool'} result</Text>
        </View>
        {open ? <Text style={s.toolText} selectable>{message.text || 'Empty'}</Text> : null}
      </Tap>
    );
  }
  if (message.role === 'user') {
    return (
      <View style={s.userWrap}>
        <View style={s.user}><Text style={s.userText} selectable>{message.text}</Text></View>
        {message.at ? <Text style={s.time}>{agoText(message.at)}</Text> : null}
      </View>
    );
  }
  return (
    <View style={{ gap: 6 }}>
      {message.tools?.length ? (
        <View style={s.chips}>
          {message.tools.map((name, i) => (
            <View key={`${name}-${i}`} style={s.chip}>
              <Wrench size={12} color={t.colors.textSecondary} />
              <Text style={s.chipText}>{name}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {message.text ? (
        <View style={message.failed ? s.failed : undefined}>
          {message.failed ? (
            <View style={s.failedHead}>
              <TriangleAlert size={14} color={t.colors.warning} />
              <Text style={s.failedLabel}>This turn didn't finish</Text>
            </View>
          ) : null}
          <Markdown text={message.text} />
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  error: { ...t.type.callout, color: t.colors.danger, marginTop: 10 },
  note: { ...t.type.caption, color: t.colors.textTertiary, textAlign: 'center' },
  userWrap: { alignItems: 'flex-end', gap: 4 },
  user: { maxWidth: '88%', paddingHorizontal: 16, paddingVertical: 11, borderRadius: t.radius.lg, borderBottomRightRadius: 6, backgroundColor: t.colors.accentFill },
  userText: { ...t.type.body, color: t.colors.onAccent },
  time: { ...t.type.caption, color: t.colors.textTertiary },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: t.radius.pill,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border },
  chipText: { ...t.type.caption, color: t.colors.textSecondary, fontFamily: t.fonts.mono },
  tool: { paddingHorizontal: 14, paddingVertical: 12, minHeight: 44, borderRadius: t.radius.lg, backgroundColor: t.colors.surface,
    borderWidth: 1, borderColor: t.colors.border, gap: 8, justifyContent: 'center' },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  toolLabel: { ...t.type.caption, color: t.colors.textSecondary, fontFamily: t.fonts.mono },
  toolText: { ...t.type.footnote, fontFamily: t.fonts.mono, color: t.colors.text },
  failed: { padding: 14, borderRadius: t.radius.lg, backgroundColor: t.colors.warningSoft, gap: 6 },
  failedHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  failedLabel: { ...t.type.caption, color: t.colors.text, fontFamily: t.fonts.semibold },
}));
