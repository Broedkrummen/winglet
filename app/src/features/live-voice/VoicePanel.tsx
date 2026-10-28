import { useEffect, useState } from 'react';
import { Linking, Platform, Text, View } from 'react-native';
import { BotAvatar } from '../../components/BotAvatar';
import { AudioLines, Check, Mic, MicOff, Square } from '../../components/icons';
import { Sheet } from '../../components/Sheet';
import { Button, Card, Footnote, ListGroup, ListRow, SectionHeader } from '../../components/ui';
import { api } from '../../lib/api';
import { usePrefs } from '../../lib/prefs';
import { useApp } from '../../lib/store';
import { makeStyles, useTheme } from '../../lib/themeContext';
import type { Server } from '../../lib/types';
import { deviceCanListen, deviceCanSpeak, probeDeviceSpeech } from './deviceSpeech';
import { phaseTitle } from './engine';
import { useLiveVoice } from './useLiveVoice';
import { speakableText } from './voiceText';

/** The orb and its meter are the stage's geometry, not a theme value. */
const ORB = 104;

/** One line of guidance for the phases where the panel has something to say. Nothing while listening. */
function idleHint(phase: string): string {
  return phase === 'idle' ? 'Speak, pause, and hear the reply.'
    : phase === 'thinking' ? 'Replies and approvals also stay in your chat.'
      : phase === 'speaking' ? 'Tap Interrupt to stop the voice and reply.'
        : phase === 'connecting' ? 'Checking speech providers…'
          : 'Your conversation stays in the chat.';
}

export function VoicePanel({ server, chatId, onClose, onType }: { server: Server; chatId: string; onClose: () => void; onType: () => void }) {
  const t = useTheme(); const s = useStyles();
  const voice = useLiveVoice(server, chatId);
  const { state, stopStatus } = voice;
  const [providers, setProviders] = useState(false);
  const [device, setDevice] = useState({listen:deviceCanListen(),speak:deviceCanSpeak(),language:'',voice:'',engine:'',listenReason:'Checking device speech...',speakReason:'Checking device speech...'});
  useEffect(() => {
    let alive=true;
    void probeDeviceSpeech().then(next=>{if(alive)setDevice(next);});
    return()=>{alive=false;};
  },[providers]);
  const [model, setModel] = useState('the selected chat model');
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);
  const messages = useApp((s) => s.runtime[server.id]?.messages[chatId]);
  const agent = useApp((s) => s.runtime[server.id]?.info?.features.agent === true);
  const online = useApp((s) => s.runtime[server.id]?.status === 'online');
  const listening = state.phase === 'listening';
  const working = ['transcribing', 'thinking', 'speaking'].includes(state.phase);
  const paused = !listening && !working && state.phase !== 'connecting';
  const close = () => { voice.end(); onClose(); };
  const type = () => { voice.end(); onType(); };
  useEffect(() => {
    let alive = true;
    if (!agent) return;
    api<any>(server, `/api/agent?chat=${encodeURIComponent(chatId)}`).then((i) => {
      const m = i.chat_model ?? i.model;
      if (alive && m) setModel(typeof m === 'string' ? m : m.label ?? m.model ?? 'the selected chat model');
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [server.id, chatId, agent]);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.code === 'Space' && !(e.target as HTMLElement)?.closest('button, input, textarea, [role="button"]')) {
        e.preventDefault(); listening ? voice.finish() : working ? voice.interrupt() : voice.start();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const unavailable = prefs.voiceListenWith === 'device' && !device.listen || prefs.voiceSpeakWith === 'device' && !device.speak;
  const disabled = !online || voice.blocked || state.phase === 'connecting' || state.muted && paused || paused && unavailable;
  const hint = state.note || (listening ? '' : idleHint(state.phase));
  const deviceName = Platform.OS === 'web' ? 'This browser' : 'On device · offline';
  const listenLabel = prefs.voiceListenWith === 'device' ? deviceName : state.session?.sttProvider || 'Server';
  const speakLabel = prefs.voiceSpeakWith === 'device' ? deviceName : state.session?.ttsProvider || 'Server';
  return <Sheet visible onClose={close} title="Hands-free voice" scrollable>
    <View style={s.header}>
      <BotAvatar name={server.bot.name} size={32} />
      <Text style={s.bot} numberOfLines={1}>{server.bot.title}</Text>
    </View>
    <View style={s.stage}>
      <View style={[s.orb, listening && { borderColor: t.colors.danger, backgroundColor: t.colors.surfaceRaised }]}>
        {working ? <AudioLines size={36} color={t.colors.accent} /> : <Mic size={36} color={listening ? t.colors.danger : t.colors.accent} />}
      </View>
      <Text style={s.status} accessibilityLiveRegion="polite">{listening && !voice.micActive ? 'Preparing microphone…' : phaseTitle(state.phase)}</Text>
      <Text style={[s.small, voice.micActive && { color: t.colors.danger }]}>{voice.micActive ? 'Microphone active' : 'Microphone off'}</Text>
      <View style={s.meter} accessible accessibilityLabel={listening ? 'Microphone level' : 'Microphone off'}>
        <View style={[s.meterFill, { width: `${listening ? Math.max(3, Math.min(100, voice.level * 250)) : 0}%` }]} />
      </View>
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
    </View>
    {state.partial ? <Text style={s.partial}>{state.partial}</Text> : null}
    {state.error ? <Card style={s.error}>
      <Text style={s.errorText}>{state.error.message}</Text>
      {state.error.code === 'permission' && Platform.OS !== 'web' ? <Button variant="ghost" size="sm" title="Open microphone settings" style={s.alignStart} onPress={() => Linking.openSettings()} /> : null}
    </Card> : null}
    {unavailable && paused ? <Text style={s.errorText}>Selected device speech is unavailable. Open Speech providers and choose Server.</Text> : null}
    {!online ? <Text style={s.errorText}>Connection lost. Audio is discarded. Reconnect, then tap to continue.</Text> : null}
    {stopStatus ? <Text style={stopStatus.startsWith('Stop unconfirmed') ? s.errorText : s.small} accessibilityLiveRegion="polite">{stopStatus}</Text> : null}
    {stopStatus.startsWith('Stop unconfirmed') ? <Button variant="ghost" size="sm" title="Retry Stop" style={s.alignStart} onPress={voice.retryStop} /> : null}
    <View style={s.controls}>
      <Button size="lg" variant={working ? 'danger' : 'primary'} disabled={disabled}
        accessibilityLabel={listening ? 'Finish speaking and send' : working ? 'Interrupt voice and stop reply' : state.phase === 'error' ? 'Retry voice' : 'Start listening'}
        title={listening ? 'Finish speaking' : working ? 'Interrupt' : state.phase === 'error' ? 'Try again' : state.phase === 'reconnecting' || state.phase === 'ended' ? 'Reconnect' : 'Tap to speak'}
        icon={working ? <Square size={18} color={t.colors.danger} /> : <Mic size={20} color={t.colors.onAccent} />}
        onPress={listening ? voice.finish : working ? voice.interrupt : voice.start} />
      <View style={s.secondaryRow}>
        <Button variant={state.muted ? 'tonal' : 'secondary'} style={s.grow}
          accessibilityLabel={state.muted ? 'Unmute microphone' : 'Mute microphone'}
          title={state.muted ? 'Unmute' : 'Mute'}
          icon={state.muted ? <MicOff size={18} color={t.colors.textSecondary} /> : <Mic size={18} color={t.colors.text} />}
          onPress={voice.mute} />
        <Button variant="secondary" style={s.grow} title="Type instead" onPress={type} />
        <Button variant="danger" style={s.grow} title="End" onPress={close} />
      </View>
    </View>
    <View style={s.provider}>
      <SectionHeader title="Speech providers" />
      <ListGroup>
        <ListRow title="Listen" value={listenLabel} disabled={!paused} onPress={() => setProviders(!providers)} />
        <ListRow title="Speak" value={speakLabel} disabled={!paused} onPress={() => setProviders(!providers)} />
      </ListGroup>
      {!paused ? <Footnote>Pause voice to change providers.</Footnote> : null}
      {providers && paused ? (['voiceListenWith', 'voiceSpeakWith'] as const).map((kind) => <View key={kind}>
        <SectionHeader title={kind === 'voiceListenWith' ? 'Listen with' : 'Speak with'} />
        <ListGroup>
          {(['server', 'device'] as const).map((value) => {
            const available = value === 'server' || (kind === 'voiceListenWith' ? device.listen : device.speak);
            const selected = prefs[kind] === value;
            const deviceTitle = Platform.OS === 'web' ? 'This browser' : available ? 'On device · offline' : 'On-device speech unavailable';
            return <ListRow key={value} title={value === 'server' ? 'Server' : deviceTitle}
              subtitle={value === 'server' ? 'Provider configured in Hermes' : kind === 'voiceListenWith' ? device.listenReason : device.speakReason}
              right={selected ? <Check size={18} color={t.colors.accent} accessibilityLabel="Selected" /> : undefined}
              disabled={!available} onPress={() => update({ [kind]: value })} accessibilityRole="radio" />;
          })}
        </ListGroup>
      </View>) : null}
      {Platform.OS === 'android' && prefs.voiceSpeakWith === 'device' && device.speak ? <Text selectable style={s.small}>{device.engine} · {device.voice} · {device.language}</Text> : null}
      <Footnote>Turn-based. Works while Winglet is in the foreground.</Footnote>
      <Footnote>Replies use {model}. Change the model in the chat.</Footnote>
    </View>
    <View style={s.transcript}>
      <SectionHeader title="Conversation" />
      {!state.turns.some((turn) => turn.userText) ? <Text style={s.small}>Your words and replies appear here.</Text> : null}
      {state.turns.slice(-4).map((turn) => {
        const reply = messages?.find((m) => m.id === turn.messageId);
        return <View key={turn.id} style={s.turn}>
          {turn.userText ? <><Text style={s.who}>You</Text><Text style={s.caption}>{turn.userText}</Text></> : null}
          {turn.replyText ? <><Text style={[s.who, { color: t.colors.accent }]}>{server.bot.title}</Text><Text style={s.caption}>{reply ? speakableText(reply.text) : turn.replyText}</Text></> : null}
          {turn.truncated ? <Text style={s.small}>Reading the first part aloud. The full reply stays in your chat.</Text> : null}
          {turn.status === 'interrupted' ? <Text style={s.small}>Interrupted</Text> : null}
        </View>;
      })}
    </View>
  </Sheet>;
}

const useStyles = makeStyles((t) => ({
  header: { flexDirection: 'row', gap: t.space.sm, alignItems: 'center', marginTop: t.space.xs },
  bot: { ...t.type.bodyStrong, color: t.colors.text, flex: 1, minWidth: 0 },
  small: { ...t.type.caption, color: t.colors.textSecondary },
  stage: { alignItems: 'center', paddingTop: t.space.xl, paddingBottom: t.space.md, gap: t.space.sm },
  orb: {
    width: ORB, height: ORB, borderRadius: ORB / 2, borderWidth: 2, borderColor: t.colors.border,
    backgroundColor: t.colors.surfaceSunken, alignItems: 'center', justifyContent: 'center',
  },
  status: { ...t.type.heading, color: t.colors.text, textAlign: 'center', marginTop: t.space.xs },
  meter: { width: ORB, height: 4, borderRadius: 2, backgroundColor: t.colors.border, overflow: 'hidden' },
  meterFill: { height: 4, borderRadius: 2, backgroundColor: t.colors.danger },
  hint: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center', maxWidth: 360, marginTop: t.space.xs },
  partial: { ...t.type.bodyStrong, color: t.colors.text, paddingVertical: t.space.md },
  error: { gap: t.space.sm, marginBottom: t.space.sm },
  errorText: { ...t.type.body, color: t.colors.danger },
  controls: { gap: t.space.sm, paddingVertical: t.space.md },
  secondaryRow: { flexDirection: 'row', gap: t.space.sm },
  grow: { flex: 1, minWidth: 0 },
  alignStart: { alignSelf: 'flex-start' },
  provider: { gap: t.space.xs, paddingBottom: t.space.md },
  transcript: { gap: t.space.xs, paddingBottom: t.space.lg },
  turn: { gap: 2, paddingVertical: t.space.xs },
  who: { ...t.type.label, color: t.colors.textSecondary, marginTop: t.space.xs },
  caption: { ...t.type.body, color: t.colors.text },
}));
