import { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import { BotAvatar } from '../../components/BotAvatar';
import { AudioLines, Mic, MicOff, Square } from '../../components/icons';
import { Sheet } from '../../components/Sheet';
import { api } from '../../lib/api';
import { usePrefs } from '../../lib/prefs';
import { useApp } from '../../lib/store';
import { makeStyles, useTheme } from '../../lib/themeContext';
import type { Server } from '../../lib/types';
import { deviceCanListen, deviceCanSpeak } from './deviceSpeech';
import { phaseTitle } from './engine';
import { useLiveVoice } from './useLiveVoice';
import { speakableText } from './voiceText';

export function VoicePanel({ server, chatId, onClose, onType }: { server: Server; chatId: string; onClose: () => void; onType: () => void }) {
  const t = useTheme(); const s = useStyles();
  const voice = useLiveVoice(server, chatId);
  const { state, stopStatus } = voice;
  const [providers, setProviders] = useState(false);
  const [model, setModel] = useState('the selected chat model');
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);
  const messages = useApp((s) => s.runtime[server.id]?.messages[chatId]);
  const online = useApp((s) => s.runtime[server.id]?.status === 'online');
  const listening = state.phase === 'listening';
  const working = ['transcribing', 'thinking', 'speaking'].includes(state.phase);
  const paused = !listening && !working && state.phase !== 'connecting';
  const close = () => { voice.end(); onClose(); };
  const type = () => { voice.end(); onType(); };
  useEffect(() => {
    let alive = true;
    api<any>(server, `/api/agent?chat=${encodeURIComponent(chatId)}`).then((i) => {
      const m = i.chat_model ?? i.model;
      if (alive && m) setModel(typeof m === 'string' ? m : m.label ?? m.model ?? 'the selected chat model');
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [server.id, chatId]);
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
  const disabled = !online || voice.blocked || state.phase === 'connecting' || state.muted && paused;
  return <Sheet visible onClose={close} title="Hands-free voice" scrollable>
    <View style={s.header}>
      <BotAvatar name={server.bot.name} size={32} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.bot}>{server.bot.title}</Text>
        <Text style={s.small}>Turn-based · Foreground only</Text>
      </View>
    </View>
    <View style={s.stage}>
      <View style={[s.orb, listening && { borderColor: t.colors.danger, backgroundColor: t.colors.surfaceRaised }]}>
        {working ? <AudioLines size={36} color={t.colors.accent} /> : <Mic size={36} color={listening ? t.colors.danger : t.colors.accent} />}
      </View>
      <Text style={s.status} accessibilityLiveRegion="polite">{listening && !voice.micActive ? 'Preparing microphone...' : phaseTitle(state.phase)}</Text>
      {voice.micActive ? <Text style={[s.small, { color: t.colors.danger }]}>● Microphone active · pause to send</Text> : <Text style={s.small}>Microphone off</Text>}
      <View style={s.meter} accessible accessibilityLabel={listening ? 'Microphone level' : 'Microphone off'}>
        <View style={[s.meterFill, { width: `${listening ? Math.max(3, Math.min(100, voice.level * 250)) : 0}%` }]} />
      </View>
      <Text style={s.instruction}>{state.note || (state.phase === 'idle' ? 'Speak, pause, and hear the reply. Winglet listens again after each reply.' : state.phase === 'thinking' ? 'Replies and approvals also stay in your chat.' : state.phase === 'speaking' ? 'Tap Interrupt to stop the voice and current reply.' : state.phase === 'connecting' ? 'Checking speech providers…' : state.phase === 'listening' ? 'The recording ends after a short pause.' : 'Your conversation stays in the chat.')}</Text>
    </View>
    {state.partial ? <Text style={s.partial}>{state.partial}</Text> : null}
    {state.error ? <View style={s.error}>
      <Text style={s.errorText}>{state.error.message}</Text>
      {state.error.code === 'permission' && Platform.OS !== 'web' ? <Pressable accessibilityRole="button" onPress={() => Linking.openSettings()} style={s.secondary}><Text style={s.link}>Open microphone settings</Text></Pressable> : null}
    </View> : null}
    {!online ? <Text style={s.errorText}>Connection lost. Audio is discarded. Reconnect, then tap to continue.</Text> : null}
    {stopStatus ? <Text style={stopStatus.startsWith('Stop unconfirmed') ? s.errorText : s.small} accessibilityLiveRegion="polite">{stopStatus}</Text> : null}
    {stopStatus.startsWith('Stop unconfirmed') ? <Pressable accessibilityRole="button" onPress={voice.retryStop} style={s.secondary}><Text style={s.link}>Retry Stop</Text></Pressable> : null}
    <View style={s.controls}>
      <Pressable accessibilityRole="button" accessibilityLabel={listening ? 'Finish speaking and send' : working ? 'Interrupt voice and stop reply' : state.phase === 'error' ? 'Retry voice' : 'Start listening'}
        disabled={disabled} accessibilityState={{ disabled }}
        onPress={listening ? voice.finish : working ? voice.interrupt : voice.start}
        style={({ pressed }) => [s.primary, { backgroundColor: working ? t.colors.danger : t.colors.accentFill }, pressed && { opacity: 0.8 }, disabled && { opacity: 0.5 }]}>
        {working ? <Square size={18} color={t.colors.onDanger} /> : <Mic size={20} color={t.colors.onAccent} />}
        <Text style={[s.primaryText, working && { color: t.colors.onDanger }]}>{listening ? 'Finish speaking' : working ? 'Interrupt' : state.phase === 'error' ? 'Try again' : state.phase === 'reconnecting' || state.phase === 'ended' ? 'Reconnect' : 'Tap to speak'}</Text>
      </Pressable>
      <View style={s.secondaryRow}>
        <Pressable accessibilityRole="button" accessibilityLabel={state.muted ? 'Unmute microphone' : 'Mute microphone'} accessibilityState={{ selected: state.muted }} onPress={voice.mute} style={s.secondary}>
          {state.muted ? <MicOff size={18} color={t.colors.text} /> : <Mic size={18} color={t.colors.text} />}
          <Text style={s.secondaryText}>{state.muted ? 'Unmute' : 'Mute'}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={type} style={s.secondary}><Text style={s.secondaryText}>Type instead</Text></Pressable>
        <Pressable accessibilityRole="button" onPress={close} style={s.secondary}><Text style={[s.secondaryText, { color: t.colors.danger }]}>End</Text></Pressable>
      </View>
    </View>
    <View style={s.provider}>
      <Pressable accessibilityRole="button" accessibilityLabel="Choose speech providers" accessibilityState={{ expanded: providers }} disabled={!paused} onPress={() => setProviders(!providers)} style={{ minHeight: 48, justifyContent: 'center' }}>
        <Text style={s.providerTitle}>Speech providers {providers ? '−' : '+'}</Text>
        <Text style={s.small}>Listen: {prefs.voiceListenWith === 'device' ? 'This browser' : state.session?.sttProvider || 'Server configuration'}</Text>
        <Text style={s.small}>Speak: {prefs.voiceSpeakWith === 'device' ? 'This browser' : state.session?.ttsProvider || 'Server configuration'}</Text>
      </Pressable>
      {!paused ? <Text style={s.small}>Pause voice to change providers.</Text> : null}
      {providers && paused ? (['voiceListenWith', 'voiceSpeakWith'] as const).map((kind) => <View key={kind} style={s.providerOptions}>
        <Text style={s.providerTitle}>{kind === 'voiceListenWith' ? 'Listen with' : 'Speak with'}</Text>
        {(['server', 'device'] as const).map((value) => {
          const available = value === 'server' || (kind === 'voiceListenWith' ? deviceCanListen() : deviceCanSpeak());
          return <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: prefs[kind] === value, disabled: !available }} disabled={!available} onPress={() => update({ [kind]: value })} style={[s.option, prefs[kind] === value && { borderColor: t.colors.accent }, !available && { opacity: 0.6 }]}>
            <Text style={s.secondaryText}>{prefs[kind] === value ? '● ' : '○ '}{value === 'server' ? 'Server · configured provider' : Platform.OS === 'web' ? 'This browser' : 'Device speech unavailable'}</Text>
            <Text style={s.small}>{value === 'server' ? 'Uses the speech provider configured in Hermes.' : !available ? Platform.OS === 'web' ? 'Unavailable in this browser.' : 'Device speech is unavailable in this native build. Use Server.' : 'Browser-managed speech may use its own online service.'}</Text>
          </Pressable>;
        })}
      </View>) : null}
      <Text style={[s.small, { marginTop: 10 }]}>Replies use {model}. Change the model in the chat.</Text>
    </View>
    <View style={s.transcript}>
      <Text style={s.providerTitle}>Conversation</Text>
      {!state.turns.some((turn) => turn.userText) ? <Text style={s.small}>Your words and replies will appear here and in the chat.</Text> : null}
      {state.turns.slice(-4).map((turn) => {
        const reply = messages?.find((m) => m.id === turn.messageId);
        return <View key={turn.id} style={s.turn}>
          {turn.userText ? <><Text style={s.who}>YOU</Text><Text style={s.caption}>{turn.userText}</Text></> : null}
          {turn.replyText ? <><Text style={[s.who, { color: t.colors.accent }]}>{server.bot.title.toUpperCase()}</Text><Text style={s.caption}>{reply ? speakableText(reply.text) : turn.replyText}</Text></> : null}
          {turn.truncated ? <Text style={s.small}>Reading the first part aloud. The full reply stays in your chat.</Text> : null}
          {turn.status === 'interrupted' ? <Text style={s.small}>Interrupted</Text> : null}
        </View>;
      })}
    </View>
  </Sheet>;
}
const useStyles = makeStyles((t) => ({
  header: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingHorizontal: 8, marginTop: 4 },
  bot: { ...t.type.bodyStrong, color: t.colors.text },
  small: { ...t.type.caption, color: t.colors.textSecondary, lineHeight: 19 },
  stage: { alignItems: 'center', paddingTop: 22, paddingBottom: 12, gap: 8 },
  orb: { width: 100, height: 100, borderRadius: 50, borderWidth: 2, borderColor: t.colors.border, backgroundColor: t.colors.surfaceSunken, alignItems: 'center', justifyContent: 'center' },
  status: { ...t.type.heading, color: t.colors.text, textAlign: 'center', marginTop: 6 },
  meter: { width: 100, height: 4, borderRadius: 2, backgroundColor: t.colors.border, overflow: 'hidden', marginTop: 2 },
  meterFill: { height: 4, borderRadius: 2, backgroundColor: t.colors.danger },
  instruction: { ...t.type.body, color: t.colors.textSecondary, textAlign: 'center', maxWidth: 360, lineHeight: 22, paddingHorizontal: 12, marginTop: 4 },
  partial: { ...t.type.bodyStrong, color: t.colors.text, padding: 12 },
  error: { backgroundColor: t.colors.surfaceSunken, borderRadius: t.radius.md, padding: 12, marginBottom: 8 },
  errorText: { ...t.type.body, color: t.colors.danger, lineHeight: 22 },
  controls: { gap: 8, paddingVertical: 12 },
  primary: { minHeight: 56, borderRadius: t.radius.pill, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 16 },
  primaryText: { ...t.type.bodyStrong, color: t.colors.onAccent, textAlign: 'center', flexShrink: 1 },
  secondaryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  secondary: { flex: 1, minHeight: 48, minWidth: 74, borderRadius: t.radius.pill, backgroundColor: t.colors.surfaceSunken, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, paddingHorizontal: 8, paddingVertical: 8 },
  secondaryText: { ...t.type.caption, fontFamily: t.fonts.semibold, color: t.colors.text, flexShrink: 1, textAlign: 'center' },
  link: { ...t.type.caption, color: t.colors.accent },
  provider: { borderTopWidth: 1, borderColor: t.colors.border, paddingHorizontal: 8, paddingVertical: 12, gap: 4 },
  providerTitle: { ...t.type.bodyStrong, color: t.colors.text },
  providerOptions: { gap: 6, marginTop: 12 },
  option: { minHeight: 60, borderWidth: 1, borderColor: t.colors.border, borderRadius: t.radius.md, padding: 10, gap: 4 },
  transcript: { borderTopWidth: 1, borderColor: t.colors.border, paddingHorizontal: 8, paddingTop: 16, paddingBottom: 8, gap: 10 },
  turn: { gap: 5, paddingVertical: 5 },
  who: { ...t.type.caption, fontFamily: t.fonts.bold, color: t.colors.textSecondary, marginTop: 5 },
  caption: { ...t.type.body, color: t.colors.text, lineHeight: 23 },
}));
