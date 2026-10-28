import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { agoText } from '../lib/agent';
import { haptic } from '../lib/haptics';
import { isOwner, useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { InboxItem } from '../lib/types';
import { Check, CheckCircle2, CircleHelp, Clock, ShieldAlert, Sparkles, XCircle } from './icons';
import { Markdown } from './Markdown';
import { Sheet } from './Sheet';
import { Button, Card, Field, ListGroup, ListRow } from './ui';

const CHOICE_ORDER = ['once', 'session', 'always', 'deny'];

/**
 * One thing from the agent that needs (or needed) you. `embedded` sits inside a chat; `bare` drops the card's own
 * frame because the Inbox wraps it in a notification card of its own.
 */
export function InboxCard({ serverId, item, compact, embedded, bare }: { serverId: string; item: InboxItem; compact?: boolean; embedded?: boolean; bare?: boolean }) {
  if (item.kind === 'approval') return <ApprovalCard serverId={serverId} item={item} compact={compact} embedded={embedded} bare={bare} />;
  if (item.kind === 'question') return <QuestionCard serverId={serverId} item={item} embedded={embedded} bare={bare} />;
  return <ResultCard serverId={serverId} item={item} compact={compact} embedded={embedded} bare={bare} />;
}

/** What kind of card this is, as a plain icon coloured by what it needs from you. */
function KindIcon({ icon: Icon, color, small }: { icon: typeof ShieldAlert; color: string; soft?: string; small?: boolean }) {
  const s = useStyles();
  return <View style={[s.kind, small && s.kindSmall]}><Icon size={small ? 16 : 18} color={color} /></View>;
}

function StatusLine({ item }: { item: InboxItem }) {
  const t = useTheme();
  const s = useStyles();
  if (item.status === 'pending') return null;
  const expired = item.status === 'expired';
  const label = expired
    ? 'Expired'
    : item.kind === 'approval'
      ? item.resolution === 'deny' ? 'You denied this' : `Approved: ${item.payload.labels?.[item.resolution] ?? item.resolution}`
      : `You answered: ${item.resolution}`;
  const Icon = expired ? Clock : item.resolution === 'deny' ? XCircle : CheckCircle2;
  const color = expired ? t.colors.textSecondary : item.resolution === 'deny' ? t.colors.danger : t.colors.success;
  return (
    <View style={s.status}>
      <Icon size={16} color={color} />
      <Text style={[s.statusText, { color }]}>{label}</Text>
    </View>
  );
}

/**
 * A request to run something risky. Hermes's own choices are offered as plain buttons: nothing is
 * approved by a gesture, and "Always" needs a second, explicit confirmation.
 */
function ApprovalCard({ serverId, item, compact, embedded, bare }: { serverId: string; item: InboxItem; compact?: boolean; embedded?: boolean; bare?: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const respond = useApp((st) => st.respond);
  const owner = useApp((st) => isOwner(st.runtime[serverId]));
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAlways, setConfirmAlways] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const acting = useRef(false);
  const choices = [...(item.payload.choices ?? [])].sort((a, b) => CHOICE_ORDER.indexOf(a) - CHOICE_ORDER.indexOf(b));
  const pending = item.status === 'pending';
  const label = (c: string) => item.payload.labels?.[c] ?? (c === 'once' ? 'Allow once' : c === 'session' ? 'Allow this session' : c === 'always' ? 'Always allow' : 'Deny');
  const act = async (choice: string) => {
    if (acting.current || !owner || useApp.getState().runtime[serverId]?.inbox[item.id]?.status !== 'pending') return;
    acting.current = true;
    setBusy(choice);
    try {
      await respond(serverId, item.id, { choice });
      const result = useApp.getState().runtime[serverId]?.inbox[item.id];
      if (result?.status === 'resolved' && result.resolution === choice) {
        if (choice === 'deny') haptic.error();
        else haptic.success();
      }
    } finally { acting.current = false; setBusy(null); }
  };
  return (
    <Card style={[s.card, embedded && s.embedded, compact && s.compactCard, bare && s.bare]} accessibilityLabel="Approval request">
      <View style={s.header}>
        <KindIcon icon={ShieldAlert} color={t.colors.warning} soft={t.colors.warningSoft} small={embedded} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.title}>{item.payload.description || (pending ? 'Run this command?' : 'Command request')}</Text>
          {embedded ? <Text style={s.subtitle}>{agoText(item.created_at)}</Text> : null}
        </View>
      </View>
      <View style={s.command}>
        {expanded ? <ScrollView nestedScrollEnabled style={{ maxHeight: compact ? 160 : 220 }}><Text selectable style={s.commandText}>{item.payload.command || item.body}</Text></ScrollView>
          : <Text style={s.commandText} numberOfLines={pending ? 2 : 1}>{item.payload.command || item.body}</Text>}
        <Button variant="ghost" size="sm" title={expanded ? 'Show less' : 'View command'}
          accessibilityLabel={expanded ? 'Show less of the command' : 'Show all of the command'}
          onPress={() => setExpanded((e) => !e)} style={{ alignSelf: 'flex-start' }} />
      </View>
      {pending && !owner ? (
        <View style={s.waiting} accessibilityLiveRegion="polite">
          <Clock size={14} color={t.colors.textSecondary} />
          <Text style={s.waitingText}>Waiting for an owner.</Text>
        </View>
      ) : pending ? (
        <View style={s.actions}>
          {choices.map((choice) => (
            <Button
              key={choice}
              size="sm"
              style={s.action}
              title={label(choice)}
              variant={choice === 'deny' ? 'danger' : choice === 'once' ? 'primary' : 'secondary'}
              loading={busy === choice}
              disabled={!!busy && busy !== choice}
              feedback="none"
              onPress={() => (choice === 'always' ? setConfirmAlways(true) : act(choice))}
            />
          ))}
        </View>
      ) : (
        <StatusLine item={item} />
      )}
      <Sheet visible={confirmAlways} onClose={() => setConfirmAlways(false)} title="Always allow this?">
        <View style={{ gap: 14, paddingHorizontal: 4 }}>
          <Text style={s.sheetText}>
            Hermes won't ask again before running commands that match this one, in any chat, until you change it on the server.
          </Text>
          <View style={s.command}><Text selectable style={s.commandText} numberOfLines={6}>{item.payload.command || item.body}</Text></View>
          <Button title="Always allow" variant="danger" onPress={() => { setConfirmAlways(false); act('always'); }} />
          <Button title="Cancel" variant="secondary" onPress={() => setConfirmAlways(false)} />
        </View>
      </Sheet>
    </Card>
  );
}

function QuestionCard({ serverId, item, embedded, bare }: { serverId: string; item: InboxItem; embedded?: boolean; bare?: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const respond = useApp((st) => st.respond);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const pending = item.status === 'pending';
  const choices = item.payload.choices ?? [];
  const multi = !!item.payload.multi_select && choices.length > 0;
  const send = async (answer: string | string[]) => {
    if (Array.isArray(answer) ? !answer.length : !answer.trim()) return;
    haptic.light();
    setBusy(true);
    await respond(serverId, item.id, { answer: Array.isArray(answer) ? answer : answer.trim() });
    setBusy(false);
  };
  const toggle = (label: string) => {
    haptic.selection();
    setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));
  };
  return (
    <Card style={[s.card, embedded && s.embedded, bare && s.bare]} accessibilityLabel="Question from the agent">
      <View style={s.header}>
        <KindIcon icon={CircleHelp} color={t.colors.textSecondary} small={embedded} />
        <Text style={[s.title, { flex: 1 }]}>{item.payload.question || item.body}</Text>
      </View>
      {pending ? (
        <>
          <ListGroup>{choices.map((choice) => {
            const recommended = /\(recommended\)\s*$/i.test(choice);
            const label = choice.replace(/\s*\(recommended\)\s*$/i, '');
            const on = picked.includes(label);
            return (
              !multi ? <ListRow key={choice} title={label} value={recommended ? 'Recommended' : undefined}
                chevron={false} disabled={busy} onPress={() => send(label)} /> : <Pressable
                key={choice}
                disabled={busy}
                accessibilityRole={multi ? 'checkbox' : 'button'}
                accessibilityState={multi ? { checked: on } : undefined}
                accessibilityLabel={recommended ? `${label}, recommended` : label}
                onPress={() => (multi ? toggle(label) : send(label))}
                style={({ pressed, hovered }: any) => [s.choice, (pressed || hovered) && { backgroundColor: t.colors.pressed }, on && s.choiceOn]}
              >
                {multi ? <View style={[s.check, on && s.checkOn]}>{on ? <Check size={13} color={t.colors.onAccent} strokeWidth={3} /> : null}</View> : null}
                <Text style={[s.choiceText, { flex: 1 }]}>{label}</Text>
                {recommended ? <Text style={s.recommended}>Recommended</Text> : null}
              </Pressable>
            );
          })}</ListGroup>
          {multi ? (
            <Button title={picked.length ? `Submit ${picked.length} selected` : 'Pick one or more'} disabled={!picked.length} loading={busy && !!picked.length} onPress={() => send(picked)} />
          ) : null}
          <View style={s.otherRow}>
            <View style={{ flex: 1 }}><Field
              value={other}
              onChangeText={setOther}
              placeholder={choices.length ? 'Something else…' : 'Type your answer…'}
              accessibilityLabel="Your answer"
              onSubmitEditing={() => send(other)}
              returnKeyType="send"
            /></View>
            <Button size="sm" title="Send" onPress={() => send(other)} disabled={!other.trim()} loading={busy && !!other} />
          </View>
        </>
      ) : (
        <StatusLine item={item} />
      )}
    </Card>
  );
}

function ResultCard({ serverId, item, compact, embedded, bare }: { serverId: string; item: InboxItem; compact?: boolean; embedded?: boolean; bare?: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const history = useApp(st => st.runtime[serverId]?.info?.features?.routine_history === true && isOwner(st.runtime[serverId]));
  const routineId = item.payload.routine_id || item.payload.job_id;
  const limit = compact ? 400 : 1200;
  return (
    <Card style={[s.card, embedded && s.embedded, bare && s.bare]}>
      <View style={s.header}>
        <KindIcon icon={Sparkles} color={t.colors.success} soft={t.colors.successSoft} small={embedded} />
        <Text style={[s.title, { flex: 1 }]}>{item.title}</Text>
      </View>
      <Markdown text={item.body.length > limit ? `${item.body.slice(0, limit)}…` : item.body} compact={compact} />
      {history && typeof routineId === 'string' ? <Button size="sm" variant="tonal" style={s.pill} title={item.payload.run_id ? 'View recorded run' : 'View routine history'}
        onPress={() => router.push(`/routine/${encodeURIComponent(serverId)}/${encodeURIComponent(routineId)}${item.payload.run_id ? `/run/${encodeURIComponent(item.payload.run_id)}` : ''}` as any)} /> : null}
    </Card>
  );
}

const useStyles = makeStyles((t) => ({
  waiting: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  waitingText: { ...t.type.callout, color: t.colors.textSecondary, flex: 1 },
  card: { padding: t.space.lg, gap: t.space.md, width: '100%' },
  embedded: { maxWidth: undefined, borderRadius: t.radius.md, padding: 10, gap: 7 },
  compactCard: { gap: 6, padding: 9, borderRadius: t.radius.sm },
  bare: { backgroundColor: 'transparent', borderWidth: 0, borderRadius: 0, padding: 0 },
  header: { flexDirection: 'row', alignItems: 'center', gap: t.space.md },
  kind: { width: 20, height: 22, alignItems: 'center', justifyContent: 'center' },
  kindSmall: { width: 18 },
  action: { flexGrow: 1 },
  pill: { alignSelf: 'flex-start' },
  title: { ...t.type.bodyStrong, color: t.colors.text },
  subtitle: { ...t.type.caption, color: t.colors.textSecondary },
  command: { backgroundColor: t.colors.codeBg, borderRadius: t.radius.md, paddingHorizontal: t.space.md, paddingVertical: 10, borderWidth: 1, borderColor: t.colors.border, gap: 2 },
  commandText: { ...t.type.footnote, fontFamily: t.fonts.mono, color: t.colors.codeText },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm },
  status: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  statusText: { ...t.type.caption, flexShrink: 1 },
  sheetText: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center' },
  choice: {
    flexDirection: 'row', alignItems: 'center', minHeight: 48, backgroundColor: 'transparent',
    paddingHorizontal: t.space.lg, borderWidth: 1, borderColor: 'transparent',
  },
  choiceText: { ...t.type.callout, fontFamily: t.fonts.medium, color: t.colors.text },
  choiceOn: { borderColor: t.colors.text, backgroundColor: t.colors.surfaceHigh },
  check: { width: 22, height: 22, borderRadius: 7, borderWidth: 2, borderColor: t.colors.textSecondary, marginRight: 12, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: t.colors.accentFill, borderColor: t.colors.accentFill },
  recommended: { ...t.type.caption, color: t.colors.onAccentSoft },
  otherRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },

}));
