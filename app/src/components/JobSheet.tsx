import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { api } from '../lib/api';
import { haptic } from '../lib/haptics';
import { spring, useReducedMotion } from '../lib/motion';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Job, Server } from '../lib/types';
import { Check, CircleAlert, CircleHelp } from './icons';
import { Sheet } from './Sheet';
import { Button, Footnote, ListGroup, ListRow, SectionHeader } from './ui';

const TITLES: Record<Job['kind'], string> = {
  restart: 'Restarting', hermes_update: 'Updating Hermes', winglet_update: 'Updating Winglet',
  skill_install: 'Installing a skill', skill_uninstall: 'Removing a skill', mcp_install: 'Adding an MCP server',
  pet_install: 'Adopting a pet',
  ability_install: 'Installing custom addition',
};
// Installs don't take the server down, so they have no steps to show.
const RESTARTS: Job['kind'][] = ['restart', 'hermes_update', 'winglet_update'];
const SLOW_MS = 3 * 60 * 1000;

/**
 * A restart, update or install, start to finish. A restart takes the server away partway through, so
 * the sheet keeps asking until a new process answers for the same job.
 */
export function JobSheet({ server, job: initial, onClose, onDone }: {
  server: Server; job: Job | null; onClose: () => void; onDone?: (job: Job) => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const [job, setJob] = useState<Job | null>(initial);
  const [lost, setLost] = useState(false);
  const [slow, setSlow] = useState(false);
  const live = useApp((st) => st.runtime[server.id]?.job);
  const reduced = useReducedMotion();
  const reported = useRef<string | null>(null);

  if (initial && initial.id !== job?.id) { setJob(initial); setLost(false); setSlow(false); }

  // Live events while connected; polling across the restart, when there's no socket.
  useEffect(() => { if (live && job && live.id === job.id && live.updated_at >= job.updated_at) setJob(live); }, [live]); // eslint-disable-line react-hooks/exhaustive-deps
  const running = job?.state === 'running';
  useEffect(() => {
    if (!job || !running) return;
    const id = setInterval(() => {
      api<{ job: Job }>(server, `/api/jobs/${job.id}`)
        .then((r) => { setLost(false); setJob(r.job); })
        .catch(() => setLost(true));
    }, 2000);
    const slowTimer = setTimeout(() => setSlow(true), Math.max(0, SLOW_MS - (Date.now() - job.created_at * 1000)));
    return () => { clearInterval(id); clearTimeout(slowTimer); };
  }, [job?.id, running]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!job || running || reported.current === job.id) return;
    reported.current = job.id;
    if (job.state === 'succeeded') haptic.success(); else haptic.error();
    onDone?.(job);
  }, [job?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!job) return null;
  const d = job.detail;
  const restarts = RESTARTS.includes(job.kind);
  const steps = !restarts ? [] : job.kind === 'hermes_update'
    ? ['Download and install', 'Restart', 'Back online']
    : job.kind === 'winglet_update' ? ['Download', 'Restart', 'Back online'] : ['Stop', 'Start again', 'Back online'];
  // Where we are: the server answering again after losing it means the last step.
  const step = !running ? 3 : lost ? 1 : /Restarting/.test(d.message ?? '') ? 1 : 0;
  const tint = job.state === 'succeeded' ? t.colors.success : job.state === 'failed' ? t.colors.danger
    : job.state === 'unknown' ? t.colors.warning : t.colors.accent;
  const soft = job.state === 'succeeded' ? t.colors.successSoft : job.state === 'failed' ? t.colors.dangerSoft
    : job.state === 'unknown' ? t.colors.warningSoft : t.colors.accentSoft;

  return (
    <Sheet visible={!!initial} onClose={onClose} title={TITLES[job.kind]}>
      <View style={{ gap: 16, paddingHorizontal: 4 }} accessibilityLiveRegion="polite">
        <View style={s.hero}>
          <View style={[s.badge, { backgroundColor: soft }]}>
            {running ? <ActivityIndicator color={tint} /> : (
              // The outcome pops into the badge with a small spring when the job ends.
              <Animated.View key={job.state} entering={reduced ? undefined : FadeIn.duration(180)}>
                {job.state === 'succeeded' ? <Check size={30} color={tint} />
                  : job.state === 'failed' ? <CircleAlert size={30} color={tint} /> : <CircleHelp size={30} color={tint} />}
              </Animated.View>
            )}
          </View>
          <Text style={s.message}>{running && lost ? 'Waiting for the server to come back…' : d.message || 'Working…'}</Text>
          {job.state === 'succeeded' && d.from && d.to && d.from !== d.to ? <Text style={s.sub}>{d.from} → {d.to}</Text> : null}
        </View>

        {steps.length ? <>
          <SectionHeader title="Progress" />
          <ListGroup>{steps.map((label, i) => {
            const done = i < step || job.state === 'succeeded';
            const active = running && i === step;
            return <ListRow key={label} title={label} value={done ? 'Done' : active ? 'Running' : 'Waiting'}
              icon={done ? <Check /> : undefined} iconColor={done ? t.colors.success : undefined} />;
          })}</ListGroup>
        </> : null}

        {d.command ? (
          <View style={{ gap: 6 }}>
            <Text style={s.sub}>Run this on the server instead:</Text>
            <Text selectable style={s.command}>{d.command}</Text>
          </View>
        ) : null}
        {slow && running && restarts ? (
          <Animated.Text entering={FadeIn} style={[s.sub, { color: t.colors.warning }]}>
            Server still offline? Run `hermes gateway start` on it.
          </Animated.Text>
        ) : null}
        {d.lines?.length && !running ? (
          <ScrollView style={s.log} contentContainerStyle={{ padding: 12 }} nestedScrollEnabled>
            <Text selectable style={s.logText}>{d.lines.join('\n')}</Text>
          </ScrollView>
        ) : null}
        <Button title={running ? 'Hide' : 'Done'} variant={running ? 'secondary' : 'primary'} onPress={onClose} />
        {running ? <Footnote>Keeps running while hidden.</Footnote> : null}
      </View>
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  hero: { alignItems: 'center', gap: t.space.md, paddingTop: t.space.sm },
  badge: { width: 72, height: 72, borderRadius: t.radius.pill, alignItems: 'center', justifyContent: 'center' },
  message: { ...t.type.heading, color: t.colors.text, textAlign: 'center' },
  sub: { ...t.type.caption, color: t.colors.textSecondary },
  command: {
    ...t.type.footnote, fontFamily: t.fonts.mono, color: t.colors.codeText, padding: t.space.md, borderRadius: t.radius.md,
    backgroundColor: t.colors.codeBg, overflow: 'hidden',
  },
  log: { maxHeight: 220, borderRadius: t.radius.md, backgroundColor: t.colors.codeBg, borderWidth: 1, borderColor: t.colors.border },
  logText: { ...t.type.footnote, fontFamily: t.fonts.mono, color: t.colors.textSecondary },
}));
