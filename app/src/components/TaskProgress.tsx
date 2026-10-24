import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { stopTask } from '../lib/actions';
import { currentTaskActivity } from '../lib/messages';
import { isOwner, useApp } from '../lib/store';
import { plainText } from '../lib/text';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Server } from '../lib/types';
import { TaskDetail, TaskStopButton, useTaskClock } from '../features/execution/TaskDetail';
import { planProgress, stripVisible, taskState } from '../features/execution/model';
import { Ban, CheckCircle2, ChevronDown, CircleHelp, ShieldQuestion, Square, XCircle } from './icons';
import { Sheet } from './Sheet';
import { Button, Tap } from './ui';

const EMPTY: never[] = [];
/** A finished task stays in reach briefly, so its outcome can be read without opening anything else. */
const LINGER_MS = 60_000;

/** The agent's actual current activity, kept in reach while you type or read older replies. */
export function TaskProgress({ server, chatId, busy }: { server: Server; chatId: string; busy: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const online = useApp((st) => st.network && st.runtime[server.id]?.status === 'online');
  const owner = useApp((st) => isOwner(st.runtime[server.id]));
  const messages = useApp((st) => st.runtime[server.id]?.messages[chatId] ?? EMPTY);
  const inbox = useApp((st) => st.runtime[server.id]?.inbox);
  const featureOn = useApp((st) => !!st.runtime[server.id]?.info?.features?.task_activity);
  const snapshot = useApp((st) => st.runtime[server.id]?.tasks?.[chatId]);
  const caps = useApp((st) => st.runtime[server.id]?.taskCaps);
  const loadTask = useApp((st) => st.loadTask);
  const pending = Object.values(inbox ?? {}).filter((item) => item.chat_id === chatId && item.status === 'pending' && item.kind !== 'result')
    .sort((a, b) => a.created_at - b.created_at)[0];
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [lingerExpired, setLingerExpired] = useState(false);
  const now = useTaskClock(!!busy && !pending);
  const state = taskState(snapshot, busy, now);

  // Load the bounded snapshot when the chat opens, when work starts, and after a reconnect.
  useEffect(() => { if (featureOn) loadTask(server.id, chatId); }, [featureOn, server.id, chatId, loadTask]);
  useEffect(() => { if (featureOn && busy) loadTask(server.id, chatId, true); }, [featureOn, busy, server.id, chatId, loadTask]);
  useEffect(() => { if (featureOn && online) loadTask(server.id, chatId, true); }, [featureOn, online, server.id, chatId, loadTask]);

  useEffect(() => setOpen(false), [pending?.id]);

  useEffect(() => {
    setLingerExpired(false);
    if (busy || pending || !snapshot) return;
    // A finished task lingers a minute; a running one gets the same window after its last fact so a
    // missing end can still say "Not confirmed" rather than disappearing.
    const since = snapshot.state === 'running' ? snapshot.updated_at : snapshot.ended_at;
    if (since == null) { setLingerExpired(snapshot.state !== 'running'); return; }
    const left = since * 1000 + LINGER_MS - Date.now();
    if (left <= 0) { setLingerExpired(true); return; }
    const timer = setTimeout(() => setLingerExpired(true), left);
    return () => clearTimeout(timer);
  }, [busy, pending?.id, snapshot?.turn_index, snapshot?.state, snapshot?.ended_at, snapshot?.updated_at]);

  if (!stripVisible(snapshot, busy, !!pending, lingerExpired)) return null;
  const steps = currentTaskActivity(messages);
  const legacy = steps.map((step) => ({ id: step.id, text: step.text }));
  const latest = steps[steps.length - 1];
  const structured = featureOn && snapshot && snapshot.turn_index > 0
    && !!(snapshot.plan?.items.length || snapshot.tools.length || snapshot.subagents.length);
  const progress = planProgress(snapshot?.plan);
  const planCurrent = snapshot?.plan?.live === false ? null : progress.current;
  const activeSub = snapshot?.subagents.find((sub) => sub.status === 'running');
  const activeTool = snapshot?.tools.find((tool) => tool.status === 'running') ?? snapshot?.tools.at(-1);
  const headline = snapshot?.outcome?.summary ?? snapshot?.reason ?? null;

  const title = pending ? pending.kind === 'approval' ? owner ? 'Approval needed' : 'Waiting for an owner' : 'A question for you'
    : !online ? 'Waiting for connection'
      : state === 'completed' ? 'Task completed' : state === 'cancelled' ? 'Task stopped' : state === 'failed' ? 'Task failed'
        : busy ? 'Working on your request' : 'Task not confirmed';
  const detail = pending ? (pending.body.trim().split('\n')[0] || pending.title)
    : headline ?? planCurrent?.content ?? activeSub?.goal ?? activeTool?.preview ?? activeTool?.name
      ?? (latest ? plainText(latest.text).split('\n')[0] : null)
      ?? (busy ? 'Updates will appear here as your bot works.' : 'This turn has not reported how it ended.');
  const terminalIcon = !online || pending ? null : busy ? null
    : state === 'completed' ? <CheckCircle2 size={19} color={t.colors.success} />
      : state === 'failed' ? <XCircle size={19} color={t.colors.danger} />
        : state === 'cancelled' ? <Ban size={19} color={t.colors.textSecondary} />
          : <CircleHelp size={19} color={t.colors.textSecondary} />;
  const openRequest = () => {
    if (!pending) return;
    setOpen(false);
    router.navigate(`/inbox?server=${encodeURIComponent(server.id)}&item=${encodeURIComponent(pending.id)}`);
  };
  const stop = async () => {
    setStopping(true);
    try { await stopTask(server, chatId); } finally { setStopping(false); }
  };
  return <>
    <View style={s.strip} accessibilityLiveRegion="polite">
      <Tap accessibilityLabel={`${title}. ${detail.replace(/[.!?]$/, '')}. ${pending ? 'Open request' : 'Show activity'}`}
        accessibilityState={{ expanded: open }} style={s.summary} onPress={() => {
          if (pending) openRequest();
          else setOpen(true);
        }}>
        {pending ? pending.kind === 'approval' ? <ShieldQuestion size={19} color={t.colors.warning} /> : <CircleHelp size={19} color={t.colors.warning} />
          : terminalIcon ?? <ActivityIndicator size="small" color={t.colors.accent} />}
        <View style={s.text}><Text style={[s.title, pending && { color: t.colors.warning }]} numberOfLines={1}>{title}</Text>
          <Text style={s.detail} numberOfLines={1}>{detail}</Text></View>
        <ChevronDown size={15} color={t.colors.textTertiary} />
      </Tap>
      {busy && !pending ? <Tap accessibilityLabel="Stop this task" accessibilityState={{ disabled: !online || stopping, busy: stopping }}
        disabled={!online || stopping} style={s.stop} onPress={stop}>
        {stopping ? <ActivityIndicator size="small" color={t.colors.textSecondary} /> : <Square size={14} color={online ? t.colors.text : t.colors.textTertiary} />}
      </Tap> : null}
    </View>
    <Sheet visible={open} onClose={() => setOpen(false)} title={pending ? title : busy ? 'Current activity' : 'Task details'}>
      <ScrollView style={{ maxHeight: 440 }} contentContainerStyle={{ gap: 16, paddingHorizontal: 8, paddingBottom: 20 }}>
        {pending ? <><Text style={s.title}>{pending.title}</Text><Text selectable style={s.activity}>{pending.body}</Text><Button title="Open request" onPress={openRequest} /></> : <>
          <TaskDetail snapshot={featureOn ? snapshot : undefined} now={now} busy={busy} online={online}
            capabilities={{ subagent_stop: caps?.subagent_stop === true }}
            legacy={structured ? [] : legacy} />
          {(!structured && !featureOn) ? <Text style={s.activity}>This server doesn’t report plans, tools or delegated tasks. Its progress notes above are all it sent.</Text> : null}
          {busy ? <TaskStopButton onStop={stop} online={online} stopping={stopping} busy={busy} /> : null}
        </>}
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
