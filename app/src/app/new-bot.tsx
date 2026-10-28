import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { PairRows, useBotHost } from '../components/AddBot';
import { BotAvatar } from '../components/BotAvatar';
import { Bot, RotateCw } from '../components/icons';
import { JobSheet } from '../components/JobSheet';
import { Screen } from '../components/Screen';
import { Button, Card, Field, SectionHeader } from '../components/ui';
import { api, ApiError, signedApi } from '../lib/api';
import { botName } from '../lib/bots';
import { idempotencyKey } from '../lib/control';
import { spring, useReducedMotion } from '../lib/motion';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { BotRow, Job } from '../lib/types';

type BotsState = { bots: BotRow[]; multiplex: boolean; reason: string };

const rise = (reduced: boolean, i: number) => (reduced ? undefined
  : FadeIn.duration(180));

/**
 * A new bot on the same server: a Hermes profile with its own persona, memory, skills, chats and pet, made the
 * way Hermes Desktop makes one. No new address or pairing. Pairing stays the way to add a bot on another server.
 */
export default function NewBotScreen() {
  const t = useTheme();
  const s = useStyles();
  const reduced = useReducedMotion();
  const { main, canMake } = useBotHost();
  const [state, setState] = useState<BotsState | null>(null);
  const [title, setTitle] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [purpose, setPurpose] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [made, setMade] = useState<{ name: string; restart: boolean } | null>(null);
  const [restarting, setRestarting] = useState<Job | null>(null);

  useEffect(() => {
    if (!canMake || !main) return;
    api<BotsState>(main, '/api/bots').then(setState).catch((e) => setError((e as Error).message));
  }, [canMake, main?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!main) return null;
  const slug = nameTouched ? name : botName(title);
  const create = async () => {
    setError('');
    setBusy(true);
    try {
      const r = await signedApi<{ job: Job }>(main, 'POST', '/api/bots', {
        name: slug, title: title.trim(), idempotency_key: idempotencyKey(),
        persona: `You are ${title.trim()}.${purpose.trim() ? ` ${purpose.trim()}` : ''}`,
        description: purpose.trim().split('\n')[0].slice(0, 300),
      });
      setJob(r.job);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.job) setJob(e.data.job as Job);
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const done = async (j: Job) => {
    if (j.state !== 'succeeded') return;
    const fresh = await api<BotsState>(main, '/api/bots').catch(() => null);
    if (fresh) {
      setState(fresh);
      await useApp.getState().syncBots(main.id, fresh.bots);
    }
    setMade({ name: slug, restart: !!(j.detail as { needs_restart?: boolean }).needs_restart });
  };
  const open = () => {
    const id = `${main.id}~${made?.name}`;
    useApp.getState().select(id, `b-${made?.name}`);
    router.replace(`/chat/${encodeURIComponent(id)}/${encodeURIComponent(`b-${made?.name}`)}`);
  };
  const restart = async () => {
    try {
      const r = await signedApi<{ job: Job }>(main, 'POST', '/api/system/restart', { idempotency_key: idempotencyKey() });
      setRestarting(r.job);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Screen title="Add a bot" subtitle={main.bot.title}>
      {canMake ? (
        made ? (
          <Animated.View entering={rise(reduced, 0)} style={s.made}>
            <BotAvatar name={made.name} size={112} mood="happy" animated glow />
            <Text style={s.lead}>{title.trim()} is ready</Text>
            {made.restart ? (
              <>
                <Text style={s.note}>Restart the server once to bring every bot online.</Text>
                <Button title="Restart the server" icon={<RotateCw size={16} color={t.colors.onAccent} />} onPress={restart} style={s.wide} />
              </>
            ) : null}
            <Button title={`Chat with ${title.trim()}`} variant={made.restart ? 'secondary' : 'primary'} onPress={open} style={s.wide} />
          </Animated.View>
        ) : (
          <View style={{ gap: 12, marginTop: 18 }}>
            {/* A face for the new bot that changes as you name it: each name gets its own. */}
            <Animated.View entering={rise(reduced, 0)} style={s.preview} accessible={false}>
              <BotAvatar name={slug || 'new'} size={96} mood={title.trim() ? 'happy' : 'idle'} animated glow />
              <Text style={s.previewName} numberOfLines={1}>{title.trim() || 'Your new bot'}</Text>
            </Animated.View>
            {state && !state.multiplex ? (
              <Card style={{ gap: 6 }}>
                <Text style={s.noticeTitle}>Restart required after creation</Text>
                <Text style={s.note}>
                  Restart once after creation{state.reason ? `: ${state.reason}` : '.'}
                </Text>
              </Card>
            ) : null}
            <Animated.View entering={rise(reduced, 1)} style={{ gap: 12 }}>
              <Field label="Name" value={title} onChangeText={setTitle} placeholder="Chef, Researcher, Tutor…" maxLength={60} />
              <Field label="Short name" value={slug} onChangeText={(v) => { setNameTouched(true); setName(botName(v)); }}
                hint="How Hermes and your other bots refer to it" autoCapitalize="none" autoCorrect={false} maxLength={40} />
              <View style={{ gap: 6 }}>
                <Text style={s.label}>What it's for</Text>
                <TextInput value={purpose} onChangeText={setPurpose} multiline placeholder="Plans meals and keeps the shopping list."
                  placeholderTextColor={t.colors.textTertiary} style={s.area} accessibilityLabel="What the bot is for" />
                <Text style={s.hint}>Sets its persona; editable later.</Text>
              </View>
            </Animated.View>
            {error ? <Text style={s.error}>{error}</Text> : null}
            <Button title="Create bot" icon={<Bot size={16} color={t.colors.onAccent} />} loading={busy}
              disabled={!title.trim() || !slug} onPress={create} />
          </View>
        )
      ) : null}

      <SectionHeader title="On another server" />
      <PairRows />

      <JobSheet server={main} job={job} onClose={() => setJob(null)} onDone={done} />
      <JobSheet server={main} job={restarting} onClose={() => setRestarting(null)} />
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  made: { gap: t.space.md, marginTop: t.space.xl, alignItems: 'center', paddingVertical: t.space.lg },
  wide: { alignSelf: 'stretch' },
  preview: { alignItems: 'center', gap: t.space.sm, paddingVertical: t.space.md },
  previewName: { ...t.type.title, color: t.colors.text, textAlign: 'center' },
  lead: { ...t.type.title, color: t.colors.text, textAlign: 'center' },
  noticeTitle: { ...t.type.bodyStrong, color: t.colors.text, textAlign: 'center' },
  note: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center' },
  label: { ...t.type.label, color: t.colors.textSecondary },
  hint: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textSecondary },
  area: { ...t.type.body, color: t.colors.text, backgroundColor: t.colors.surfaceSunken, borderRadius: t.radius.md, padding: 14,
    minHeight: 110, textAlignVertical: 'top', ...({ outlineStyle: 'none' } as object) },
  error: { ...t.type.callout, color: t.colors.danger },
}));
