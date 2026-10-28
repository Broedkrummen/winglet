import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, FadeOutUp } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { api } from '../lib/api';
import { haptic } from '../lib/haptics';
import { spring, useReducedMotion } from '../lib/motion';
import { isOwner, useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Goal, Server } from '../lib/types';
import { Check, ChevronRight, CirclePause, Plus, Target, X } from './icons';
import { FloatingPill, Sheet } from './Sheet';
import { Button, ConfirmButton, Field, IconButton, Tap } from './ui';

/** A ring that fills as the goal uses its turn budget; the icon inside says its state. */
export function GoalRing({ goal, size = 36, stroke = 3.5 }: { goal: Goal; size?: number; stroke?: number }) {
  const t = useTheme();
  const tone = goalTone(goal, t.colors);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const used = goal.max_turns ? Math.min(1, goal.turns_used / goal.max_turns) : 0;
  const icon = Math.round(size * 0.42);
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={t.colors.borderStrong} strokeWidth={stroke} fill="none" />
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={tone} strokeWidth={stroke} fill="none" strokeLinecap="round"
          strokeDasharray={`${c} ${c}`} strokeDashoffset={c * (1 - (goal.status === 'done' ? 1 : Math.max(0.04, used)))} />
      </Svg>
      {goal.status === 'done' ? <Check size={icon} color={tone} /> : goal.status === 'paused' ? <CirclePause size={icon} color={tone} /> : <Target size={icon} color={tone} />}
    </View>
  );
}

function goalTone(goal: Goal, c: { accent: string; warning: string; success: string }) {
  return goal.status === 'done' ? c.success : goal.status === 'paused' ? c.warning : c.accent;
}

/** One line on what the goal is doing right now. */
export function goalStatus(goal: Goal): string {
  if (goal.status === 'done') return 'Done';
  if (goal.status === 'paused') return goal.paused_reason ? `Paused: ${goal.paused_reason}` : 'Paused';
  if (goal.waiting_reason) return `Waiting: ${goal.waiting_reason}`;
  return `Working on it · turn ${goal.turns_used} of ${goal.max_turns}`;
}

/** The goal a chat is working toward, refreshed whenever a reply lands. */
export function useChatGoal(server: Server, chatId: string, enabled = true) {
  const supported = useApp((st) => !!st.runtime[server.id]?.info?.features?.goals);
  const online = useApp((st) => st.runtime[server.id]?.status === 'online');
  const lastReply = useApp((st) => st.runtime[server.id]?.lastReplyAt);
  const [snapshot, setGoal] = useState<{ key: string; goal: Goal | null } | null>(null);
  const key = `${server.id}:${chatId}`;
  const current = useRef<string | null>(null);
  current.current = enabled ? key : null;
  const refresh = useCallback(() => {
    if (!supported || !online || !enabled) return;
    api<{ goal: Goal | null }>(server, `/api/chats/${encodeURIComponent(chatId)}/goal`).then((d) => {
      if (current.current === key) setGoal({ key, goal: d.goal });
    }).catch(() => undefined);
  }, [server, chatId, supported, online, enabled, key]);
  useEffect(refresh, [refresh, lastReply]);
  return { goal: enabled && snapshot?.key === key ? snapshot.goal : null, refresh, supported };
}

/** Under the chat header while the chat has a goal. Tap for the details and controls. */
export function GoalStrip({ goal, onPress }: { goal: Goal; onPress: () => void }) {
  const t = useTheme();
  const s = useStyles();
  const reduced = useReducedMotion();
  return (
    <Animated.View entering={reduced ? FadeIn.duration(120) : FadeIn.duration(180)}
      exiting={reduced ? FadeOut.duration(120) : FadeOutUp.duration(160)} style={s.float}>
      <Tap feedback="selection" scaleTo={0.97} onPress={onPress} accessibilityLabel={`Goal: ${goal.goal}. ${goalStatus(goal)}. Details`}>
        <FloatingPill style={s.strip}>
          <GoalRing goal={goal} size={30} stroke={3} />
          <View style={s.stripText}>
            <Text style={s.stripGoal} numberOfLines={1}>{goal.goal}</Text>
            <Text style={[s.stripStatus, { color: goalTone(goal, t.colors) }]} numberOfLines={1}>{goalStatus(goal)}</Text>
          </View>
          <ChevronRight size={16} color={t.colors.textTertiary} />
        </FloatingPill>
      </Tap>
    </Animated.View>
  );
}

/**
 * The goal in full: progress, the judge's latest note, extra criteria, and the controls. Changes go
 * through Hermes's own /goal and /subgoal, so they show in the chat and follow Hermes's rules.
 */
export function GoalSheet({ server, chatId, goal, visible, onClose, onChanged }: {
  server: Server; chatId: string; goal: Goal | null; visible: boolean; onClose: () => void; onChanged: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const owner = useApp((st) => isOwner(st.runtime[server.id]));
  const [draft, setDraft] = useState('');
  const [sub, setSub] = useState('');
  const fresh = !goal || goal.status === 'done';
  const [writing, setWriting] = useState(false);
  useEffect(() => { if (visible) { setDraft(''); setSub(''); setWriting(false); } }, [visible]);

  const send = (text: string, close = false) => {
    haptic.selection();
    useApp.getState().sendMessage(server.id, chatId, text);
    setTimeout(onChanged, 1500);
    if (close) onClose();
  };

  const addSub = () => {
    const text = sub.trim();
    if (!text) return;
    send(`/subgoal ${text}`);
    setSub('');
  };

  const newGoal = fresh || writing;
  return (
    <Sheet visible={visible} onClose={onClose} title={newGoal ? 'Set a goal' : 'Goal'}>
      <View style={{ gap: 16, paddingHorizontal: 4 }}>
        {newGoal ? (
          owner ? (
            <>
              <Text style={s.note}>
                {server.bot.title} keeps working on it, turn after turn, until a judge model decides it's done or it uses its
                turn budget. You can pause or clear it any time.
              </Text>
              <Field value={draft} onChangeText={setDraft} multiline autoFocus placeholder="Get the test suite passing on the main branch"
                style={{ minHeight: 88, textAlignVertical: 'top' }} accessibilityLabel="What should it work toward?" />
              <Button title="Start working on it" icon={<Target size={16} color={t.colors.onAccent} />} disabled={!draft.trim()}
                onPress={() => send(`/goal ${draft.trim()}`, true)} />
              {writing ? <Button title="Back" variant="ghost" onPress={() => setWriting(false)} /> : null}
            </>
          ) : <Text style={s.note}>Only an owner can set a goal.</Text>
        ) : goal ? (
          <>
            <View style={s.hero}>
              <GoalRing goal={goal} size={68} stroke={6} />
              <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                <Text style={s.goal}>{goal.goal}</Text>
                <Text style={[s.status, { color: goalTone(goal, t.colors) }]}>{goalStatus(goal)}</Text>
              </View>
            </View>
            {goal.last_reason && goal.status !== 'paused' ? (
              <View style={s.noteBox}>
                <Text style={s.label}>Latest check</Text>
                <Text style={s.note}>{goal.last_reason}</Text>
              </View>
            ) : null}
            <View style={{ gap: 8 }}>
              <Text style={s.label}>Also needs to</Text>
              {goal.subgoals.length ? goal.subgoals.map((g, i) => (
                <View key={`${i}-${g}`} style={s.subgoal}>
                  <View style={s.subBadge}><Text style={s.subIndex}>{i + 1}</Text></View>
                  <Text style={s.subText}>{g}</Text>
                  {owner ? (
                    <IconButton label={`Remove ${g}`} size={32} onPress={() => send(`/subgoal remove ${i + 1}`)}>
                      <X size={15} color={t.colors.textSecondary} />
                    </IconButton>
                  ) : null}
                </View>
              )) : <Text style={s.note}>Nothing extra. Add a requirement the result must meet.</Text>}
              {owner ? (
                <View style={s.addRow}>
                  <View style={{ flex: 1 }}>
                    <Field value={sub} onChangeText={setSub} placeholder="Add a requirement" onSubmitEditing={addSub}
                      accessibilityLabel="Add a requirement" returnKeyType="done" />
                  </View>
                  <IconButton label="Add requirement" variant="tonal" size={44} onPress={addSub}>
                    <Plus size={18} color={t.colors.textSecondary} />
                  </IconButton>
                </View>
              ) : null}
            </View>
            {owner ? (
              <View style={{ gap: 10 }}>
                {goal.status === 'paused'
                  ? <Button title="Resume" onPress={() => send('/goal resume', true)} />
                  : <Button title="Pause" variant="secondary" onPress={() => send('/goal pause', true)} />}
                <Button title="Set a different goal" variant="ghost" onPress={() => setWriting(true)} />
                <ConfirmButton title="Clear goal" onConfirm={() => send('/goal clear', true)} />
              </View>
            ) : null}
          </>
        ) : null}
      </View>
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  float: { alignSelf: 'center', width: '100%', maxWidth: 544, marginTop: t.space.sm, paddingHorizontal: t.space.md },
  strip: { paddingLeft: 7, paddingRight: t.space.md, paddingVertical: 6, gap: 10 },
  stripText: { flexShrink: 1, minWidth: 0 },
  stripGoal: { ...t.type.footnote, fontFamily: t.fonts.semibold, color: t.colors.text },
  stripStatus: { ...t.type.caption, fontSize: 11.5, lineHeight: 14 },
  hero: {
    flexDirection: 'row', alignItems: 'center', gap: t.space.lg, padding: t.space.lg, borderRadius: t.radius.lg,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
  },
  goal: { ...t.type.heading, color: t.colors.text },
  status: { ...t.type.caption, fontFamily: t.fonts.semibold },
  label: { ...t.type.caption, fontFamily: t.fonts.semibold, letterSpacing: 0.6, textTransform: 'uppercase', color: t.colors.textTertiary, paddingHorizontal: t.space.xs },
  note: { ...t.type.callout, color: t.colors.textSecondary },
  noteBox: { gap: 6, padding: t.space.lg, borderRadius: t.radius.lg, backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border },
  subgoal: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: t.space.md, paddingVertical: t.space.xs, borderRadius: t.radius.lg,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
  },
  subBadge: { width: 24, height: 24, borderRadius: t.radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.surfaceSunken },
  subIndex: { ...t.type.caption, fontFamily: t.fonts.semibold, color: t.colors.textSecondary },
  subText: { ...t.type.callout, color: t.colors.text, flex: 1, paddingVertical: 6 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
}));
