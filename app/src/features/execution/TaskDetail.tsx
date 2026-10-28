import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import {
  Ban, Check, CheckCircle2, ChevronDown, ChevronRight, Circle, CircleDashed, CircleHelp, CircleSlash,
  Clock, Square, XCircle,
} from '../../components/icons';
import { Button, Tap } from '../../components/ui';
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

const toolTone = (t: Theme, state: ToolSnapshot['status']) => ({
  completed: t.colors.success, failed: t.colors.danger, running: t.colors.accent, unknown: t.colors.textSecondary,
}[state]);

/**
 * The status mark at the start of a row: small and coloured. Its word is the accessible label; on screen the
 * icon and colour carry it, so the word is only printed where the icon alone would not say enough.
 */
function Mark({ label, children }: { label: string; children: ReactNode }) {
  const s = useStyles();
  return <View accessible accessibilityLabel={label} style={s.mark}>{children}</View>;
}

function SubagentMark({ state }: { state: SubagentSnapshot['status'] }) {
  const t = useTheme();
  const color = subagentTone(t, state);
  return (
    <Mark label={subagentStateLabel(state)}>
      {state === 'running' ? <ActivityIndicator size="small" color={color} />
        : state === 'completed' ? <Check size={16} color={color} />
          : state === 'failed' ? <XCircle size={16} color={color} />
            : state === 'cancelled' ? <Ban size={16} color={color} />
              : state === 'queued' ? <Clock size={16} color={color} />
                : <CircleDashed size={16} color={color} />}
    </Mark>
  );
}

function ToolMark({ status }: { status: ToolSnapshot['status'] }) {
  const t = useTheme();
  const color = toolTone(t, status);
  return (
    <Mark label={toolStateLabel(status)}>
      {status === 'running' ? <ActivityIndicator size="small" color={color} />
        : status === 'completed' ? <Check size={16} color={color} />
          : status === 'failed' ? <XCircle size={16} color={color} />
            : <CircleHelp size={16} color={color} />}
    </Mark>
  );
}

function PlanRow({ content, status, depth, live }: { content: string; status: PlanItemState; depth: number; live: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const color = status === 'completed' ? t.colors.success : status === 'in_progress' && live ? t.colors.accent : t.colors.textTertiary;
  const mark = status === 'in_progress' && live ? <ActivityIndicator size="small" color={color} />
    : status === 'in_progress' ? <CircleDashed size={16} color={color} />
      : status === 'completed' ? <Check size={16} color={color} />
        : status === 'cancelled' ? <CircleSlash size={16} color={color} />
          : <Circle size={16} color={color} />;
  return (
    <View style={[s.row, { paddingLeft: depth * t.space.lg }]}>
      <Mark label={planStateLabel(status, live)}>{mark}</Mark>
      <Text selectable style={[s.rowText, status === 'completed' && s.done, status === 'cancelled' && s.struck]}>{content}</Text>
      {status === 'in_progress' && !live ? <Text style={s.rowNote}>{planStateLabel(status, live)}</Text> : null}
    </View>
  );
}

function ToolRow({ tool }: { tool: ToolSnapshot }) {
  const t = useTheme();
  const s = useStyles();
  const duration = durationLabel(tool.duration_ms);
  // Running and done are plain from the icon; only the states the icon can't say get a word.
  const quiet = tool.status === 'running' || tool.status === 'completed';
  return (
    <View style={s.row}>
      <ToolMark status={tool.status} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={s.titleLine}>
          <Text style={[s.rowTitle, { flexShrink: 1 }]} numberOfLines={1}>{tool.name}</Text>
          {quiet ? null : <Text style={[s.caption, { color: toolTone(t, tool.status) }]}>{toolStateLabel(tool.status)}</Text>}
          {duration ? <Text style={s.mono}>{duration}</Text> : null}
        </View>
        {tool.preview ? <Text style={s.preview} numberOfLines={2}>{tool.preview}</Text> : null}
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
  const duration = durationLabel(sub.duration_ms);
  const showState = sub.status !== 'running' && sub.status !== 'completed';
  const details = [
    sub.role && sub.role !== 'leaf' ? sub.role : null,
    showState ? subagentStateLabel(sub.status) : null,
    sub.tool_count ? `${sub.tool_count} ${sub.tool_count === 1 ? 'tool' : 'tools'}` : null,
  ].filter(Boolean).join(' · ');
  const detail = live ? sub.activity.at(-1)?.name ?? null : sub.summary ?? sub.activity.at(-1)?.name ?? null;
  const expandable = sub.activity.length > 0 || !!sub.summary || children.length > 0;
  return (
    <View>
      <Tap
        disabled={!expandable}
        accessibilityRole={expandable ? 'button' : undefined}
        accessibilityLabel={`${sub.goal || 'Subagent'}. ${[showState ? null : subagentStateLabel(sub.status), details, duration].filter(Boolean).join(' · ')}${detail ? `. ${detail}` : ''}`}
        accessibilityState={expandable ? { expanded: open } : undefined}
        onPress={() => setOpen((value) => !value)}
        style={s.row}
      >
        <SubagentMark state={sub.status} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.rowTitle} numberOfLines={open ? undefined : 2}>{sub.goal || 'Delegated task'}</Text>
          {details ? <Text style={[s.caption, sub.status === 'failed' && { color: t.colors.danger }]} numberOfLines={1}>{details}</Text> : null}
          {!open && detail ? <Text style={s.detail} numberOfLines={1}>{detail}</Text> : null}
        </View>
        {duration ? <Text style={s.mono}>{duration}</Text> : null}
        {expandable ? (open ? <ChevronDown size={16} color={t.colors.textTertiary} />
          : <ChevronRight size={16} color={t.colors.textTertiary} />) : null}
      </Tap>
      {open ? (
        <View style={s.subBody}>
          {sub.activity.length ? (
            <View style={s.stack}>
              <Text style={s.eyebrow}>Activity</Text>
              {sub.activity.map((line, i) => (
                <Text key={`${line.name}-${i}`} selectable style={s.activityLine} numberOfLines={3}>
                  {line.name}{line.detail ? `: ${line.detail}` : ''}
                </Text>
              ))}
            </View>
          ) : null}
          {sub.summary ? (
            <View style={s.stack}>
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

function Section({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  const s = useStyles();
  return (
    <View style={s.section}>
      <View style={s.sectionHead}>
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
    <View style={s.root}>
      {snapshot && snapshot.turn_index > 0 ? (
        <View style={s.head} accessibilityLiveRegion="polite">
          <StateIcon state={state} size={16} color={color} />
          <Text style={[s.stateText, { color }]}>{stateLabel(state)}</Text>
          {elapsed ? <Text style={s.elapsed}>{elapsed}</Text> : null}
        </View>
      ) : null}

      {plan && plan.items.length ? (
        <Section title={plan.live ? 'Plan' : 'Last plan'} meta={`${progress.done} of ${progress.total} done`}>
          <View style={s.barTrack} accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: Math.max(1, progress.total), now: progress.done,
              text: `${progress.done} of ${progress.total} steps done` }}
            accessibilityLabel={`Plan progress: ${progress.done} of ${progress.total} steps done`}>
            <View style={[s.barFill, { width: `${Math.round(progress.fraction * 100)}%` }]} />
          </View>
          {planTree(plan).map(({ item, depth }) => (
            <PlanRow key={item.id} content={item.content} status={item.status} depth={depth}
              live={live && plan.live !== false} />
          ))}
          {!plan.live ? <Text style={s.note}>The agent has not written a plan for the current turn.</Text> : null}
        </Section>
      ) : null}

      {subagents.length ? (
        <Section title="Subagents"
          meta={[`${allSubagents.filter((sub) => isSubagentLive(sub.status)).length} working`,
            `${allSubagents.filter((sub) => sub.status === 'completed').length} done`,
            allSubagents.some((sub) => sub.status === 'failed')
              ? `${allSubagents.filter((sub) => sub.status === 'failed').length} failed` : null].filter(Boolean).join(' · ')}>
          {subagents.map((sub) => (
            <SubagentRow key={sub.id} sub={sub} all={allSubagents} depth={0} capabilities={capabilities} />
          ))}
        </Section>
      ) : null}

      {running.length || finished.length ? (
        <Section title="Tools" meta={`${tools.length} ${tools.length === 1 ? 'call' : 'calls'}`}>
          {running.map((tool) => <ToolRow key={tool.id} tool={tool} />)}
          {finished.length ? (
            <Button variant="ghost" size="sm" style={s.alignStart}
              accessibilityLabel={`${showFinished ? 'Hide' : 'Show'} ${finished.length} finished tool ${finished.length === 1 ? 'call' : 'calls'}`}
              title={showFinished ? 'Hide finished' : `${finished.length} finished`}
              icon={showFinished ? <ChevronDown size={15} color={t.colors.accent} /> : <ChevronRight size={15} color={t.colors.accent} />}
              onPress={() => setShowFinished((value) => !value)} />
          ) : null}
          {showFinished ? finished.map((tool) => <ToolRow key={tool.id} tool={tool} />) : null}
        </Section>
      ) : null}

      {snapshot && state && state !== 'running' ? (
        <Section title="Outcome">
          <Text selectable style={[s.outcome, { color: state === 'failed' ? t.colors.danger : t.colors.text }]}>
            {state === 'completed' ? 'The agent finished this turn.'
              : state === 'cancelled' ? 'You stopped this task.'
                : state === 'failed' ? 'This task failed.'
                  : "The server didn't report how this ended."}
          </Text>
          {snapshot.reason ? <Text selectable style={s.caption}>{snapshot.reason}</Text> : null}
          {snapshot.outcome?.summary ? <Text selectable style={s.caption}>{snapshot.outcome.summary}</Text> : null}
        </Section>
      ) : null}

      {legacy.length ? (
        <Section title="Activity">
          <Text style={s.note}>
            {snapshot && snapshot.turn_index > 0
              ? 'Progress notes for this turn.'
              : 'This server sends progress notes only.'}
          </Text>
          {legacy.map((line) => <Text key={line.id} selectable style={s.activityLine}>{line.text}</Text>)}
        </Section>
      ) : null}

      {!snapshot && !legacy.length ? (
        <Text style={s.caption}>{busy ? 'Tools, plan steps and subagents appear here.' : 'No activity from the last turn.'}</Text>
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
  if (!busy) return null;
  return (
    <Button variant="secondary" accessibilityLabel={label} title={online ? label : 'Reconnect to stop'}
      loading={stopping} disabled={!online || stopping} onPress={onStop}
      icon={<Square size={14} color={online ? t.colors.text : t.colors.textTertiary} />} />
  );
}

const useStyles = makeStyles((t) => ({
  root: { gap: t.space.xl },
  head: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm },
  stateText: { ...t.type.callout, fontFamily: t.fonts.semibold },
  elapsed: { ...t.type.caption, fontFamily: t.fonts.mono, color: t.colors.textSecondary },
  section: { gap: t.space.xs },
  sectionHead: { flexDirection: 'row', alignItems: 'baseline', gap: t.space.sm, marginBottom: t.space.xs },
  sectionTitle: { ...t.type.label, color: t.colors.textSecondary },
  sectionMeta: { ...t.type.caption, color: t.colors.textTertiary, marginLeft: 'auto' },
  barTrack: { height: 4, borderRadius: 2, backgroundColor: t.colors.surfaceSunken, overflow: 'hidden', marginBottom: t.space.sm },
  barFill: { height: '100%', borderRadius: 2, backgroundColor: t.colors.accent },
  mark: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: t.space.sm, minHeight: 40, paddingVertical: 8 },
  rowTitle: { ...t.type.callout, fontFamily: t.fonts.medium, color: t.colors.text },
  rowText: { ...t.type.callout, color: t.colors.text, flex: 1, minWidth: 0 },
  rowNote: { ...t.type.caption, color: t.colors.textTertiary, marginTop: 2 },
  done: { color: t.colors.textSecondary },
  struck: { textDecorationLine: 'line-through', color: t.colors.textTertiary },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm, flexWrap: 'wrap' },
  caption: { ...t.type.caption, color: t.colors.textSecondary },
  detail: { ...t.type.caption, color: t.colors.textSecondary, marginTop: 2 },
  mono: { ...t.type.caption, fontFamily: t.fonts.mono, color: t.colors.textTertiary },
  preview: { ...t.type.caption, fontFamily: t.fonts.mono, color: t.colors.textSecondary, marginTop: 2 },
  error: { ...t.type.caption, color: t.colors.danger, marginTop: 2 },
  note: { ...t.type.caption, color: t.colors.textTertiary },
  stack: { gap: 2 },
  subBody: { paddingLeft: 28, paddingBottom: t.space.sm, gap: t.space.sm },
  eyebrow: { ...t.type.label, color: t.colors.textTertiary },
  activityLine: { ...t.type.caption, fontFamily: t.fonts.mono, color: t.colors.textSecondary },
  subSummary: { ...t.type.callout, color: t.colors.textSecondary },
  children: { marginLeft: 10, paddingLeft: 18, borderLeftWidth: 1, borderLeftColor: t.colors.borderStrong },
  alignStart: { alignSelf: 'flex-start' },
  outcome: { ...t.type.callout, fontFamily: t.fonts.medium },
}));
