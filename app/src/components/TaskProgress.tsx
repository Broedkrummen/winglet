import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { stopTask } from '../lib/actions';
import { currentTaskActivity } from '../lib/messages';
import { useApp } from '../lib/store';
import { plainText } from '../lib/text';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Server } from '../lib/types';
import { ChevronDown, CircleHelp, ShieldQuestion, Square } from './icons';
import { Sheet } from './Sheet';
import { Button, Tap } from './ui';

const EMPTY: never[] = [];

/** The agent's actual current activity, kept in reach while you type or read older replies. */
export function TaskProgress({ server, chatId, busy }: { server: Server; chatId: string; busy: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const online = useApp((st) => st.network && st.runtime[server.id]?.status === 'online');
  const messages = useApp((st) => st.runtime[server.id]?.messages[chatId] ?? EMPTY);
  const inbox = useApp((st) => st.runtime[server.id]?.inbox);
  const pending = Object.values(inbox ?? {}).filter((item) => item.chat_id === chatId && item.status === 'pending' && item.kind !== 'result')
    .sort((a, b) => a.created_at - b.created_at)[0];
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  useEffect(() => setOpen(false), [busy, pending?.id]);
  if (!busy && !pending) return null;
  const steps = currentTaskActivity(messages);
  const latest = steps[steps.length - 1];
  const title = pending ? pending.kind === 'approval' ? 'Approval needed' : 'A question for you'
    : !online ? 'Waiting for connection' : 'Working on your request';
  const detail = pending ? pending.title : latest ? plainText(latest.text).split('\n')[0] : 'Updates will appear here as your bot works.';
  const openRequest = () => {
    if (!pending) return;
    setOpen(false);
    router.navigate(`/inbox?server=${encodeURIComponent(server.id)}&item=${encodeURIComponent(pending.id)}`);
  };
  return <>
    <View style={s.strip} accessibilityLiveRegion="polite">
      <Tap accessibilityLabel={`${title}. ${detail}. ${pending ? 'Open request' : 'Show activity'}`}
        accessibilityState={{ expanded: open }} style={s.summary} onPress={() => {
          if (pending) openRequest();
          else setOpen(true);
        }}>
        {pending ? pending.kind === 'approval' ? <ShieldQuestion size={19} color={t.colors.warning} /> : <CircleHelp size={19} color={t.colors.warning} />
          : <ActivityIndicator size="small" color={t.colors.accent} />}
        <View style={s.text}><Text style={[s.title, pending && { color: t.colors.warning }]} numberOfLines={1}>{title}</Text>
          <Text style={s.detail} numberOfLines={1}>{detail}</Text></View>
        <ChevronDown size={15} color={t.colors.textTertiary} />
      </Tap>
      {busy && !pending ? <Tap accessibilityLabel="Stop this task" accessibilityState={{ disabled: !online || stopping, busy: stopping }}
        disabled={!online || stopping} style={s.stop} onPress={async () => {
          setStopping(true);
          try { await stopTask(server, chatId); } finally { setStopping(false); }
        }}>
        {stopping ? <ActivityIndicator size="small" color={t.colors.textSecondary} /> : <Square size={14} color={online ? t.colors.text : t.colors.textTertiary} />}
      </Tap> : null}
    </View>
    <Sheet visible={open} onClose={() => setOpen(false)} title={pending ? title : 'Current activity'}>
      <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 8, paddingBottom: 16 }}>
        {pending ? <><Text style={s.title}>{pending.title}</Text><Text selectable style={s.activity}>{pending.body}</Text><Button title="Open request" onPress={openRequest} /></>
          : steps.length ? steps.map((step) => <Text key={step.id} selectable style={s.activity}>{step.text}</Text>)
          : <Text style={s.activity}>{detail}</Text>}
      </ScrollView>
    </Sheet>
  </>;
}

const useStyles = makeStyles((t) => ({
  strip: { flexDirection: 'row', alignItems: 'center', paddingRight: 6, borderRadius: 16, backgroundColor: t.colors.surface,
    borderWidth: 1, borderColor: t.colors.borderStrong, marginBottom: 8 },
  summary: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, minHeight: 64 },
  text: { flex: 1, minWidth: 0, gap: 3 },
  title: { ...t.type.caption, fontFamily: t.fonts.semibold, color: t.colors.text },
  detail: { ...t.type.caption, color: t.colors.textSecondary, fontSize: 12 },
  stop: { height: 44, width: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: t.colors.surfaceSunken },
  activity: { ...t.type.callout, color: t.colors.textSecondary },
}));
