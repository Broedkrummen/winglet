import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import {
  Ban, Check, CheckCircle2, ChevronDown, ChevronRight, Circle, CircleDashed, CircleHelp, CircleSlash,
  Clock, ListChecks, Square, Wrench, XCircle,
} from '../../components/icons';
import { Tap } from '../../components/ui';
import type { Theme } from '../../lib/theme';
import { makeStyles, useTheme } from '../../lib/themeContext';
import {
  durationLabel, elapsedLabel, isSubagentLive, orderedSubagents, planProgress, planStateLabel, planTree,
  stateLabel, subagentChildren, subagentStateLabel, taskState, toolStateLabel,
} from './model';
import type {
  PlanItemState, SubagentSnapshot, TaskCapabilities, TaskSnapshot, TaskState, ToolSnapshot,
} from './model';

/** Ticks a running task's elapsed time once a second; stops as soon as the task is no longer running. */
export function useTaskClock(active: boolean, now = Date.now()): number {
  const [tick, setTick] = useState(now);
  useEffect(() => {
    if (!active) return;
    setTick(Date.now());
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return active ? tick : now;
}

const tone = (t: Theme, state: TaskState | null) => ({
  running: t.colors.accent, completed: t.colors.success, failed: t.colors.danger,
  cancelled: t.colors.textSecondary, unknown: t.colors.textSecondary,
}[state ?? 'unknown']);

function StateIcon({ state, size = 18, color }: { state: TaskState | null; size?: number; color: string }) {
  if (state === 'running') return <ActivityIndicator size="small" color={color} />;
  if (state === 'completed') return <CheckCircle2 size={size} color={color} />;
  if (state === 'failed') return <XCircle size={size} color={color} />;
  if (state === 'cancelled') return <Ban size={size} color={color} />;
  return <CircleHelp size={size} color={color} />;
}

const subagentTone = (t: Theme, state: SubagentSnapshot['status']) => ({
  running: t.colors.accent, queued: t.colors.textSecondary, completed: t.colors.success,
  failed: t.colors.danger, cancelled: t.colors.textSecondary, unwatched: t.colors.textTertiary,
  unknown: t.colors.textSecondary,
}[state]);

function SubagentDisc({ state }: { state: SubagentSnapshot['status'] }) {
  const t = useTheme();
  const color = subagentTone(t, state);
  const fill = state === 'running' ? t.colors.accentSoft : state === 'completed' ? t.colors.successSoft
    : state === 'failed' ? t.colors.dangerSoft : t.colors.surfaceSunken;
  return (
    <View style={[discBase, { backgroundColor: fill }]} accessibilityElementsHidden importantForAccessibility="no">
      {state === 'running' ? <ActivityIndicator size="small" color={color} />
        : state === 'completed' ? <Check size={13} color={color} />
          : state === 'failed' ? <XCircle size={13} color={color} />
            : state === 'cancelled' ? <Ban size={13} color={color} />
              : state === 'queued' ? <Clock size={13} color={color} />
                : <CircleDashed size={13} color={color} />}
    </View>
  );
}
const discBase = { width: 26, height: 26, borderRadius: 13, alignItems: 'center' as const, justifyContent: 'center' as const };

function PlanRow({ content, status, depth, live }: { content: string; status: PlanItemState; depth: number; live: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const color = status === 'completed' ? t.colors.success : status === 'in_progress' && live ? t.colors.accent : t.colors.textTertiary;
  return (
    <View style={[s.planRow, { paddingLeft: depth * 16 }]}>
      <View style={s.planMark} accessibilityElementsHidden importantForAccessibility="no">
        {status === 'in_progress' && live ? <ActivityIndicator size="small" color={color} />
          : status === 'in_progress' ? <CircleDashed size={14} color={color} />
            : status === 'completed' ? <Check size={14} color={color} />
              : status === 'cancelled' ? <CircleSlash size={14} color={color} />
                : <Circle size={14} color={color} />}
      </View>
      <Text selectable style={[s.planText, status === 'cancelled' && s.strikethrough,
        status === 'completed' && { color: t.colors.textSecondary }]}>
        {content}
      </Text>
      <Text style={[s.rowState, { color }]}>{planStateLabel(status, live)}</Text>
    </View>
  );
}

function ToolRow({ tool }: { tool: ToolSnapshot }) {
  const t = useTheme();
  const s = useStyles();
  const color = tool.status === 'completed' ? t.colors.success : tool.status === 'failed' ? t.colors.danger
    : tool.status === 'running' ? t.colors.accent : t.colors.textSecondary;
  const duration = durationLabel(tool.duration_ms);
  return (
    <View style={s.toolRow}>
      <View style={s.planMark} accessibilityElementsHidden importantForAccessibility="no">
        {tool.status === 'running' ? <ActivityIndicator size="small" color={color} />
          : tool.status === 'completed' ? <Check size={14} color={color} />
            : tool.status === 'failed' ? <XCircle size={14} color={color} />
              : <CircleHelp size={14} color={color} />}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={s.toolTitle}>
          <Text style={s.toolName} numberOfLines={1}>{tool.name}</Text>
          <Text style={[s.rowState, { color }]}>{toolStateLabel(tool.status)}{duration ? ` · ${duration}` : ''}</Text>
        </View>
        {tool.preview ? <Text style={s.toolPreview} numberOfLines={2}>{tool.preview}</Text> : null}
        {!tool.started_known ? <Text style={s.note}>Started before this app connected.</Text> : null}
        {tool.error ? <Text selectable style={s.error}>{tool.error}</Text> : null}
      </View>
    </View>
  );
}

function SubagentRow({ sub, all, depth, capabilities }: {
  sub: SubagentSnapshot; all: SubagentSnapshot[]; depth: number; capabilities: TaskCapabilities;
}) {
  const t = useTheme();
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const children = subagentChildren(all, sub.id, depth);
  const live = isSubagentLive(sub.status);
  const color = subagentTone(t, sub.status);
  const duration = durationLabel(sub.duration_ms);
  const meta = [sub.role && sub.role !== 'leaf' ? sub.role : null, subagentStateLabel(sub.status), duration,
    sub.tool_count ? `${sub.tool_count} ${sub.tool_count === 1 ? 'tool' : 'tools'}` : null].filter(Boolean).join(' · ');
  const detail = live ? sub.activity.at(-1)?.name ?? null : sub.summary ?? sub.activity.at(-1)?.name ?? null;
  const expandable = sub.activity.length > 0 || !!sub.summary || children.length > 0;
  return (
    <View style={depth ? s.childWrap : undefined}>
      <Tap
        disabled={!expandable}
        accessibilityRole={expandable ? 'button' : undefined}
        accessibilityLabel={`${sub.goal || 'Subagent'}. ${meta}${detail ? `. ${detail}` : ''}`}
        accessibilityState={expandable ? { expanded: open } : undefined}
        onPress={() => setOpen((value) => !value)}
        style={s.subRow}
      >
        <SubagentDisc state={sub.status} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.subGoal} numberOfLines={open ? undefined : 2}>{sub.goal || 'Delegated task'}</Text>
          <Text style={[s.subMeta, { color: sub.status === 'failed' ? t.colors.danger : t.colors.textTertiary }]} numberOfLines={1}>{meta}</Text>
          {!open && detail ? <Text style={s.subDetail} numberOfLines={1}>{detail}</Text> : null}
        </View>
        {expandable ? (open ? <ChevronDown size={16} color={t.colors.textTertiary} />
          : <ChevronRight size={16} color={t.colors.textTertiary} />) : null}
      </Tap>
      {open ? (
        <View style={s.subBody}>
          {sub.activity.length ? (
            <View style={{ gap: 3 }}>
              <Text style={s.eyebrow}>Activity</Text>
              {sub.activity.map((line, i) => (
                <Text key={`${line.name}-${i}`} selectable style={s.activityLine} numberOfLines={3}>
                  {line.name}{line.detail ? `: ${line.detail}` : ''}
                </Text>
              ))}
            </View>
          ) : null}
          {sub.summary ? (
            <View style={{ gap: 3 }}>
              <Text style={s.eyebrow}>{sub.status === 'failed' ? 'What went wrong' : 'Result'}</Text>
              <Text selectable style={[s.subSummary, sub.status === 'failed' && { color: t.colors.danger }]}>{sub.summary}</Text>
            </View>
          ) : null}
          {!capabilities.subagent_stop && live ? (
            <Text style={s.note}>This server stops the whole task, not one delegated task.</Text>
          ) : null}
        </View>
      ) : null}
      {children.length ? (
        <View style={s.children}>
          {children.map((child) => <SubagentRow key={child.id} sub={child} all={all} depth={depth + 1} capabilities={capabilities} />)}
        </View>
      ) : null}
    </View>
  );
}

function Section({ title, meta, icon, children }: { title: string; meta?: string; icon?: React.ReactNode; children: React.ReactNode }) {
  const s = useStyles();
  return (
    <View style={s.section}>
      <View style={s.sectionHead}>
        {icon}
        <Text style={s.sectionTitle} accessibilityRole="header">{title}</Text>
        {meta ? <Text style={s.sectionMeta}>{meta}</Text> : null}
      </View>
      {children}
    </View>
  );
}

/**
 * The current task, layer by layer: where it stands and how long it ran, the plan Hermes wrote, the
 * subagents it delegated to (nested), then tools. Finished detail is folded until asked for. Nothing
 * here is inferred: a fact the server did not report says "Not confirmed".
 */
export function TaskDetail({ snapshot, capabilities, legacy, busy, online, now }: {
  snapshot?: TaskSnapshot; capabilities: TaskCapabilities; legacy: { id: string; text: string }[];
  busy: boolean; online: boolean; now: number;
}) {
  const t = useTheme();
  const s = useStyles();
  const [showFinished, setShowFinished] = useState(false);
  const state = taskState(snapshot, busy, now);
  const plan = snapshot?.plan ?? null;
  const progress = planProgress(plan);
  const subagents = orderedSubagents(snapshot?.subagents ?? []).filter((sub) => !sub.parent_id
    || !(snapshot?.subagents ?? []).some((row) => row.id === sub.parent_id));
  const allSubagents = snapshot?.subagents ?? [];
  const tools = snapshot?.tools ?? [];
  const running = tools.filter((tool) => tool.status === 'running');
  const finished = tools.filter((tool) => tool.status !== 'running');
  const elapsed = snapshot ? elapsedLabel(snapshot, now) : null;
  const color = tone(t, state);
  const live = state === 'running';

  return (
    <View style={{ gap: 18 }}>
      {snapshot && snapshot.turn_index > 0 ? (
        <View style={s.headRow} accessibilityLiveRegion="polite">
          <View style={[s.statePill, { borderColor: color }]}>
            <StateIcon state={state} size={16} color={color} />
            <Text style={[s.stateText, { color }]}>{stateLabel(state)}</Text>
          </View>
          {elapsed ? <Text style={s.elapsed}>{elapsed}</Text> : null}
          {!online ? <Text style={s.offline}>Not updating</Text> : null}
        </View>
      ) : null}

      {plan && plan.items.length ? (
        <Section title={plan.live ? 'Plan' : 'Last plan'} meta={`${progress.done} of ${progress.total} done`}
          icon={<ListChecks size={16} color={t.colors.textSecondary} />}>
          <View style={s.barTrack} accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: Math.max(1, progress.total), now: progress.done,
              text: `${progress.done} of ${progress.total} steps done` }}
            accessibilityLabel={`Plan progress: ${progress.done} of ${progress.total} steps done`}>
            <View style={[s.barFill, { width: `${Math.round(progress.fraction * 100)}%` }]} />
          </View>
          {planTree(plan).map(({ item, depth }) => (
            <PlanRow key={item.id} content={item.content} status={item.status} depth={depth} live={live} />
          ))}
          {!plan.live ? <Text style={s.note}>The agent has not written a plan for the current turn.</Text> : null}
        </Section>
      ) : null}

      {subagents.length ? (
        <Section title="Subagents"
          meta={[`${allSubagents.filter((sub) => isSubagentLive(sub.status)).length} working`,
            `${allSubagents.filter((sub) => sub.status === 'completed').length} done`,
            allSubagents.some((sub) => sub.status === 'failed')
              ? `${allSubagents.filter((sub) => sub.status === 'failed').length} failed` : null].filter(Boolean).join(' · ')}
          icon={<CircleDashed size={16} color={t.colors.textSecondary} />}>
          {subagents.map((sub) => (
            <SubagentRow key={sub.id} sub={sub} all={allSubagents} depth={0} capabilities={capabilities} />
          ))}
        </Section>
      ) : null}

      {running.length || finished.length ? (
        <Section title="Tools" meta={`${tools.length} ${tools.length === 1 ? 'call' : 'calls'}`}
          icon={<Wrench size={16} color={t.colors.textSecondary} />}>
          {running.map((tool) => <ToolRow key={tool.id} tool={tool} />)}
          {finished.length ? (
            <Tap accessibilityRole="button" accessibilityState={{ expanded: showFinished }}
              accessibilityLabel={`${showFinished ? 'Hide' : 'Show'} ${finished.length} finished tool ${finished.length === 1 ? 'call' : 'calls'}`}
              onPress={() => setShowFinished((value) => !value)} style={s.finishedToggle}>
              <Text style={s.finishedText}>{showFinished ? 'Hide finished' : `${finished.length} finished`}</Text>
              {showFinished ? <ChevronDown size={15} color={t.colors.textTertiary} />
                : <ChevronRight size={15} color={t.colors.textTertiary} />}
            </Tap>
          ) : null}
          {showFinished ? finished.map((tool) => <ToolRow key={tool.id} tool={tool} />) : null}
        </Section>
      ) : null}

      {snapshot && state && state !== 'running' ? (
        <Section title="Outcome" icon={<StateIcon state={state} size={16} color={color} />}>
          <Text style={[s.outcome, { color: state === 'failed' ? t.colors.danger : t.colors.text }]}>
            {state === 'completed' ? 'The agent finished this turn.'
              : state === 'cancelled' ? 'You stopped this task.'
                : state === 'failed' ? 'This task failed.'
                  : "The server didn't report how this ended."}
          </Text>
          {snapshot.reason ? <Text selectable style={s.outcomeDetail}>{snapshot.reason}</Text> : null}
          {snapshot.outcome?.summary ? <Text selectable style={s.outcomeDetail}>{snapshot.outcome.summary}</Text> : null}
        </Section>
      ) : null}

      {legacy.length ? (
        <Section title="Activity" icon={<Clock size={16} color={t.colors.textSecondary} />}>
          <Text style={s.note}>
            {snapshot && snapshot.turn_index > 0
              ? "Hermes's progress notes for this turn, as they arrived."
              : 'This server does not report structured task details. These are its progress notes.'}
          </Text>
          {legacy.map((line) => <Text key={line.id} selectable style={s.activityLine}>{line.text}</Text>)}
        </Section>
      ) : null}

      {!snapshot && !legacy.length ? (
        <View style={s.emptyState}>
          <CircleDashed size={20} color={t.colors.textTertiary} />
          <Text style={s.emptyText}>{busy
            ? 'Details appear when Hermes reports a tool, a plan step or a delegated task.'
            : 'No structured activity from the last turn.'}</Text>
        </View>
      ) : null}

      {!online ? <Text style={s.note}>Not updating. Reconnect to follow this task.</Text> : null}
    </View>
  );
}

/** The Stop control used by the sheet: the same operation as the strip, with its refusal states. */
export function TaskStopButton({ onStop, online, stopping, busy, label = 'Stop this task' }: {
  onStop: () => void; online: boolean; stopping: boolean; busy: boolean; label?: string;
}) {
  const t = useTheme();
  const s = useStyles();
  if (!busy) return null;
  return (
    <Tap accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !online || stopping, busy: stopping }}
      disabled={!online || stopping} onPress={onStop} style={[s.stopButton, (!online || stopping) && { opacity: 0.5 }]}>
      {stopping ? <ActivityIndicator size="small" color={t.colors.text} /> : <Square size={13} color={online ? t.colors.text : t.colors.textTertiary} />}
      <Text style={s.stopText}>{online ? label : 'Reconnect to stop'}</Text>
    </Tap>
  );
}

const useStyles = makeStyles((t) => ({
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  statePill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: t.radius.pill,
    paddingHorizontal: 10, paddingVertical: 5, backgroundColor: t.colors.surface },
  stateText: { ...t.type.caption, fontFamily: t.fonts.semibold },
  elapsed: { ...t.type.caption, fontFamily: t.fonts.mono, color: t.colors.textSecondary },
  offline: { ...t.type.caption, color: t.colors.warning },
  section: { gap: 8 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  sectionTitle: { ...t.type.heading, color: t.colors.text, flexShrink: 1 },
  sectionMeta: { ...t.type.caption, color: t.colors.textSecondary, marginLeft: 'auto' },
  barTrack: { height: 5, borderRadius: 3, backgroundColor: t.colors.surfaceSunken, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 3, backgroundColor: t.colors.accent },
  planRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 5, minHeight: 34 },
  planMark: { width: 18, alignItems: 'center', paddingTop: 1 },
  planText: { ...t.type.callout, color: t.colors.text, flex: 1, minWidth: 0 },
  strikethrough: { textDecorationLine: 'line-through', color: t.colors.textTertiary },
  rowState: { ...t.type.caption, fontSize: 11.5, marginLeft: 6 },
  toolRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 6 },
  toolTitle: { flexDirection: 'row', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' },
  toolName: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.text, flexShrink: 1 },
  toolPreview: { ...t.type.caption, fontFamily: t.fonts.mono, color: t.colors.textSecondary, marginTop: 1 },
  error: { ...t.type.caption, color: t.colors.danger, marginTop: 2 },
  note: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textTertiary },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingVertical: 6, paddingRight: 4,
    borderRadius: t.radius.sm },
  subGoal: { ...t.type.callout, fontFamily: t.fonts.medium, color: t.colors.text },
  subMeta: { ...t.type.caption, fontSize: 11.5, marginTop: 1 },
  subDetail: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textSecondary, marginTop: 2 },
  subBody: { paddingLeft: 36, paddingBottom: 6, gap: 10 },
  subSummary: { ...t.type.callout, color: t.colors.textSecondary },
  eyebrow: { ...t.type.label, color: t.colors.textTertiary, fontSize: 10.5 },
  activityLine: { ...t.type.caption, fontFamily: t.fonts.mono, fontSize: 12, color: t.colors.textSecondary },
  children: { marginLeft: 12, paddingLeft: 12, borderLeftWidth: 1, borderLeftColor: t.colors.borderStrong, gap: 2 },
  childWrap: { gap: 2 },
  finishedToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 40, alignSelf: 'flex-start' },
  finishedText: { ...t.type.caption, color: t.colors.textSecondary },
  outcome: { ...t.type.callout, fontFamily: t.fonts.medium },
  outcomeDetail: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textSecondary },
  emptyState: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12 },
  emptyText: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textSecondary, flex: 1, minWidth: 0 },
  stopButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 46,
    borderRadius: t.radius.pill, borderWidth: 1, borderColor: t.colors.borderStrong, backgroundColor: t.colors.surface },
  stopText: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.text },
}));
