import { useState } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { agoText } from '../lib/agent';
import { haptic } from '../lib/haptics';
import { isOwner, useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { InboxItem } from '../lib/types';
import { Check, CheckCircle2, CircleHelp, Clock, ShieldAlert, Sparkles, XCircle } from './icons';
import { Markdown } from './Markdown';
import { Sheet } from './Sheet';
import { Button } from './ui';

const CHOICE_ORDER = ['once', 'session', 'always', 'deny'];

export function InboxCard({ serverId, item, compact }: { serverId: string; item: InboxItem; compact?: boolean }) {
  if (item.kind === 'approval') return <ApprovalCard serverId={serverId} item={item} compact={compact} />;
  if (item.kind === 'question') return <QuestionCard serverId={serverId} item={item} />;
  return <ResultCard item={item} compact={compact} />;
}

function StatusLine({ item }: { item: InboxItem }) {
  const t = useTheme();
  const s = useStyles();
  if (item.status === 'pending') return null;
  const expired = item.status === 'expired';
  const label = expired
    ? 'Expired · the agent stopped waiting'
    : item.kind === 'approval'
      ? item.resolution === 'deny' ? 'You denied this' : `Approved · ${item.payload.labels?.[item.resolution] ?? item.resolution}`
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
function ApprovalCard({ serverId, item, compact }: { serverId: string; item: InboxItem; compact?: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const respond = useApp((st) => st.respond);
  const owner = useApp((st) => isOwner(st.runtime[serverId]));
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAlways, setConfirmAlways] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const choices = [...(item.payload.choices ?? [])].sort((a, b) => CHOICE_ORDER.indexOf(a) - CHOICE_ORDER.indexOf(b));
  const pending = item.status === 'pending';
  const label = (c: string) => item.payload.labels?.[c] ?? (c === 'once' ? 'Allow once' : c === 'session' ? 'Allow this session' : c === 'always' ? 'Always allow' : 'Deny');
  const act = async (choice: string) => {
    setBusy(choice);
    await respond(serverId, item.id, { choice });
    if (choice === 'deny') haptic.error();
    else haptic.success();
    setBusy(null);
  };
  return (
    <View style={[s.card, pending && { borderColor: t.colors.warning }]} accessibilityLabel="Approval request">
      <View style={s.header}>
        <View style={[s.iconWrap, { backgroundColor: t.colors.warningSoft }]}><ShieldAlert size={15} color={t.colors.warning} /></View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.title}>Wants to run a command</Text>
          <Text style={s.subtitle} numberOfLines={1}>{item.payload.description ? `${item.payload.description} · ` : ''}{agoText(item.created_at)}</Text>
        </View>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={expanded ? 'Show less of the command' : 'Show all of the command'}
        onPress={() => setExpanded((e) => !e)} style={s.command}>
        <Text selectable={expanded} style={s.commandText} numberOfLines={expanded ? (compact ? 12 : undefined) : 3}>{item.payload.command || item.body}</Text>
      </Pressable>
      {pending && !owner ? (
        <View style={s.waiting} accessibilityLiveRegion="polite">
          <Clock size={14} color={t.colors.textSecondary} />
          <Text style={s.waitingText}>Waiting for an owner to approve or deny this.</Text>
        </View>
      ) : pending ? (
        <View style={s.actions}>
          {choices.map((choice) => (
            <Button
              key={choice}
              size="sm"
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
    </View>
  );
}

function QuestionCard({ serverId, item }: { serverId: string; item: InboxItem }) {
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
    <View style={[s.card, pending && { borderColor: t.colors.accent }]} accessibilityLabel="Question from the agent">
      <View style={s.header}>
        <View style={[s.iconWrap, { backgroundColor: t.colors.accentSoft }]}><CircleHelp size={15} color={t.colors.onAccentSoft} /></View>
        <Text style={[s.title, { flex: 1 }]}>{item.payload.question || item.body}</Text>
      </View>
      {pending ? (
        <>
          {choices.map((choice) => {
            const recommended = /\(recommended\)\s*$/i.test(choice);
            const label = choice.replace(/\s*\(recommended\)\s*$/i, '');
            const on = picked.includes(label);
            return (
              <Pressable
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
          })}
          {multi ? (
            <Button title={picked.length ? `Submit ${picked.length} selected` : 'Pick one or more'} disabled={!picked.length} loading={busy && !!picked.length} onPress={() => send(picked)} />
          ) : null}
          <View style={s.otherRow}>
            <TextInput
              value={other}
              onChangeText={setOther}
              placeholder={choices.length ? 'Something else…' : 'Type your answer…'}
              placeholderTextColor={t.colors.textTertiary}
              accessibilityLabel="Your answer"
              style={s.otherInput}
              onSubmitEditing={() => send(other)}
              returnKeyType="send"
            />
            <Button size="sm" title="Send" onPress={() => send(other)} disabled={!other.trim()} loading={busy && !!other} />
          </View>
        </>
      ) : (
        <StatusLine item={item} />
      )}
    </View>
  );
}

function ResultCard({ item, compact }: { item: InboxItem; compact?: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const limit = compact ? 400 : 1200;
  return (
    <View style={s.card}>
      <View style={s.header}>
        <View style={[s.iconWrap, { backgroundColor: t.colors.successSoft }]}><Sparkles size={18} color={t.colors.success} /></View>
        <Text style={[s.title, { flex: 1 }]}>{item.title}</Text>
      </View>
      <Markdown text={item.body.length > limit ? `${item.body.slice(0, limit)}…` : item.body} />
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  waiting: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  waitingText: { ...t.type.callout, color: t.colors.textSecondary, flex: 1 },
  card: { backgroundColor: t.colors.surface, borderRadius: t.radius.lg, padding: 12, gap: 10, borderWidth: 1, borderColor: t.colors.border, maxWidth: 560, width: '100%' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconWrap: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  title: { ...t.type.bodyStrong, fontSize: 15, color: t.colors.text },
  subtitle: { ...t.type.caption, color: t.colors.textSecondary },
  command: { backgroundColor: t.colors.codeBg, borderRadius: t.radius.sm, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: t.colors.border },
  commandText: { fontFamily: t.fonts.mono, fontSize: 12.5, lineHeight: 17, color: t.colors.codeText },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  statusText: { fontFamily: t.fonts.semibold, fontSize: 14 },
  sheetText: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center' },
  choice: {
    flexDirection: 'row', alignItems: 'center', minHeight: 44, backgroundColor: t.colors.surfaceSunken,
    borderRadius: t.radius.md, paddingHorizontal: 14, borderWidth: 1, borderColor: 'transparent',
  },
  choiceText: { ...t.type.callout, fontFamily: t.fonts.medium, color: t.colors.text },
  choiceOn: { borderColor: t.colors.accent, backgroundColor: t.colors.accentSoft },
  check: { width: 22, height: 22, borderRadius: 7, borderWidth: 2, borderColor: t.colors.textSecondary, marginRight: 12, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: t.colors.accentFill, borderColor: t.colors.accentFill },
  recommended: { ...t.type.label, fontSize: 11, color: t.colors.onAccentSoft },
  otherRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  otherInput: {
    flex: 1, minWidth: 0, minHeight: 44, backgroundColor: t.colors.surfaceSunken, color: t.colors.text, ...t.type.callout, borderRadius: t.radius.pill,
    paddingHorizontal: 16, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
}));
