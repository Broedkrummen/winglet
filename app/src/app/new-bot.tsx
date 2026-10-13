import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { BotAvatar } from '../components/BotAvatar';
import { Bot, QrCode, RotateCw } from '../components/icons';
import { JobSheet } from '../components/JobSheet';
import { Screen } from '../components/Screen';
import { Button, Card, Field, ListGroup, ListRow, SectionHeader } from '../components/ui';
import { api, ApiError, signedApi } from '../lib/api';
import { botName } from '../lib/bots';
import { idempotencyKey } from '../lib/control';
import { isOwner, useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { BotRow, Job } from '../lib/types';

type BotsState = { bots: BotRow[]; multiplex: boolean; reason: string };

/**
 * A new bot on the same server: a Hermes profile with its own persona, memory, skills, chats and pet, made the
 * way Hermes Desktop makes one. No new address or pairing. Pairing stays the way to add a bot on another server.
 */
export default function NewBotScreen() {
  const t = useTheme();
  const s = useStyles();
  const main = useApp((st) => {
    const selected = st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0];
    return selected?.parent ? st.servers.find((x) => x.id === selected.parent) : selected;
  });
  const rt = useApp((st) => (main ? st.runtime[main.id] : undefined));
  const canMake = !!main && !!rt?.info?.features?.bots && isOwner(rt);
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
    <Screen title="Add a bot" subtitle={canMake
      ? `A new agent on ${main.bot.title}'s server, for one job: its own persona, memory, skills, chats and pet. It's ready on this phone straight away, no pairing.`
      : 'Pair a bot from another Hermes server.'}>
      {canMake ? (
        made ? (
          <Card style={{ gap: 12, marginTop: 18, alignItems: 'center' }}>
            <BotAvatar name={made.name} size={64} mood="happy" animated glow />
            <Text style={s.lead}>{title.trim()} is ready</Text>
            {made.restart ? (
              <>
                <Text style={s.note}>Hermes is serving only your main bot right now. Restart the server once and it serves every bot.</Text>
                <Button title="Restart the server" icon={<RotateCw size={16} color={t.colors.onAccent} />} onPress={restart} />
              </>
            ) : null}
            <Button title={`Chat with ${title.trim()}`} variant={made.restart ? 'secondary' : 'primary'} onPress={open} />
          </Card>
        ) : (
          <View style={{ gap: 12, marginTop: 18 }}>
            {state && !state.multiplex ? (
              <Card style={{ gap: 6 }}>
                <Text style={s.lead}>One restart after you make it</Text>
                <Text style={s.note}>
                  Hermes serves one profile until there are two{state.reason ? ` (${state.reason})` : ''}. After you make this bot,
                  restart the server once from here.
                </Text>
              </Card>
            ) : null}
            <Field label="Name" value={title} onChangeText={setTitle} placeholder="Chef, Researcher, Tutor…" maxLength={60} />
            <Field label="Short name" value={slug} onChangeText={(v) => { setNameTouched(true); setName(botName(v)); }}
              hint="How Hermes and your other bots refer to it" autoCapitalize="none" autoCorrect={false} maxLength={40} />
            <View style={{ gap: 6 }}>
              <Text style={s.label}>What it's for</Text>
              <TextInput value={purpose} onChangeText={setPurpose} multiline placeholder="Plans the week's meals, keeps the shopping list, and suggests recipes from what's in the fridge."
                placeholderTextColor={t.colors.textTertiary} style={s.area} accessibilityLabel="What the bot is for" />
              <Text style={s.hint}>This becomes its persona. You can change it later under Persona.</Text>
            </View>
            {error ? <Text style={s.error}>{error}</Text> : null}
            <Button title={`Make ${title.trim() || 'the bot'}`} icon={<Bot size={16} color={t.colors.onAccent} />} loading={busy}
              disabled={!title.trim() || !slug} onPress={create} />
          </View>
        )
      ) : null}

      <SectionHeader title="On another server" />
      <ListGroup>
        <ListRow icon={<QrCode size={18} color={t.colors.onAccentSoft} />} title="Pair a bot" subtitle="Scan the code from `hermes winglet pair`"
          onPress={() => router.push('/pair')} />
      </ListGroup>

      <JobSheet server={main} job={job} onClose={() => setJob(null)} onDone={done} />
      <JobSheet server={main} job={restarting} onClose={() => setRestarting(null)} />
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  lead: { ...t.type.bodyStrong, color: t.colors.text, textAlign: 'center' },
  note: { ...t.type.callout, color: t.colors.textSecondary },
  label: { ...t.type.label, color: t.colors.textSecondary },
  hint: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textSecondary },
  area: { ...t.type.body, color: t.colors.text, backgroundColor: t.colors.surfaceSunken, borderRadius: t.radius.md, padding: 14,
    minHeight: 110, textAlignVertical: 'top' },
  error: { ...t.type.callout, color: t.colors.danger },
}));
