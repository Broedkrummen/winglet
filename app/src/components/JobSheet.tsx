import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { api } from '../lib/api';
import { haptic } from '../lib/haptics';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Job, Server } from '../lib/types';
import { Check, CircleAlert, CircleHelp } from './icons';
import { Sheet } from './Sheet';
import { Button } from './ui';

const TITLES: Record<Job['kind'], string> = {
  restart: 'Restarting', hermes_update: 'Updating Hermes', winglet_update: 'Updating Winglet',
  skill_install: 'Installing a skill', skill_uninstall: 'Removing a skill', mcp_install: 'Adding an MCP server',
  pet_install: 'Adopting a pet',
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

  return (
    <Sheet visible={!!initial} onClose={onClose} title={TITLES[job.kind]}>
      <View style={{ gap: 16, paddingHorizontal: 4 }} accessibilityLiveRegion="polite">
        <View style={s.hero}>
          <View style={[s.badge, { backgroundColor: job.state === 'running' ? t.colors.accentSoft : job.state === 'succeeded' ? t.colors.successSoft : job.state === 'failed' ? t.colors.dangerSoft : t.colors.warningSoft }]}>
            {running ? <ActivityIndicator color={tint} />
              : job.state === 'succeeded' ? <Check size={26} color={tint} />
              : job.state === 'failed' ? <CircleAlert size={26} color={tint} /> : <CircleHelp size={26} color={tint} />}
          </View>
          <Text style={s.message}>{running && lost ? 'Waiting for the server to come back…' : d.message || 'Working…'}</Text>
          {job.state === 'succeeded' && d.from && d.to && d.from !== d.to ? <Text style={s.sub}>{d.from} → {d.to}</Text> : null}
        </View>

        {steps.length ? <View style={s.steps}>
          {steps.map((label, i) => {
            const done = i < step || job.state === 'succeeded';
            const active = running && i === step;
            return (
              <View key={label} style={s.step}>
                <View style={[s.dot, done ? { backgroundColor: t.colors.success, borderColor: t.colors.success }
                  : active ? { borderColor: t.colors.accent } : null]}>
                  {done ? <Check size={11} color={t.colors.onAccent} /> : active ? <View style={[s.pip, { backgroundColor: t.colors.accent }]} /> : null}
                </View>
                <Text style={[s.stepText, (done || active) && { color: t.colors.text }]}>{label}</Text>
              </View>
            );
          })}
        </View> : null}

        {d.command ? (
          <View style={{ gap: 6 }}>
            <Text style={s.sub}>Run this on the server instead:</Text>
            <Text selectable style={s.command}>{d.command}</Text>
          </View>
        ) : null}
        {slow && running && restarts ? (
          <Animated.Text entering={FadeIn} style={[s.sub, { color: t.colors.warning }]}>
            This is taking longer than usual. If the server doesn't come back on its own, start it with `hermes gateway start`.
          </Animated.Text>
        ) : null}
        {d.lines?.length && !running ? (
          <ScrollView style={s.log} contentContainerStyle={{ padding: 12 }} nestedScrollEnabled>
            <Text selectable style={s.logText}>{d.lines.join('\n')}</Text>
          </ScrollView>
        ) : null}
        <Button title={running ? 'Hide' : 'Done'} variant={running ? 'secondary' : 'primary'} onPress={onClose} />
        {running ? <Text style={[s.sub, { textAlign: 'center' }]}>It keeps going if you close this.</Text> : null}
      </View>
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  hero: { alignItems: 'center', gap: 10, paddingTop: 4 },
  badge: { width: 64, height: 64, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  message: { ...t.type.bodyStrong, color: t.colors.text, textAlign: 'center' },
  sub: { ...t.type.caption, color: t.colors.textSecondary },
  steps: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, paddingHorizontal: 4 },
  step: { flex: 1, alignItems: 'center', gap: 6 },
  dot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: t.colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
  pip: { width: 8, height: 8, borderRadius: 4 },
  stepText: { ...t.type.caption, fontSize: 12, color: t.colors.textTertiary, textAlign: 'center' },
  command: {
    fontFamily: t.fonts.mono, fontSize: 13, color: t.colors.text, padding: 12, borderRadius: t.radius.md,
    backgroundColor: t.colors.surfaceSunken,
  },
  log: { maxHeight: 220, borderRadius: t.radius.md, backgroundColor: t.colors.surfaceSunken },
  logText: { fontFamily: t.fonts.mono, fontSize: 11.5, lineHeight: 17, color: t.colors.textSecondary },
}));
