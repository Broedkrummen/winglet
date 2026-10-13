import {
  RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState,
} from 'expo-audio';
import { Image } from 'expo-image';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation, FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming, ZoomIn,
} from 'react-native-reanimated';
import { attachFiles, canSend, removeFile, retryFile, sendDraft } from '../lib/attach';
import { loadCommands, matchCommands, type Command } from '../lib/commands';
import { haptic } from '../lib/haptics';
import { formatDuration, pickFiles, pickMedia, takePhoto, type PickedFile } from '../lib/media';
import { easeOut, useReducedMotion } from '../lib/motion';
import { usePrefs } from '../lib/prefs';
import { draftKey, useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import { plainText } from '../lib/text';
import type { DraftFile, Server } from '../lib/types';
import { Glass } from './Glass';
import { ArrowUp, Camera, FileText, ImagePlus, Mic, Plus, RotateCcw, Square, X } from './icons';
import { Sheet, SheetAction } from './Sheet';
import { Chip, Tap, Toggle } from './ui';

const MIN_INPUT = 41;
const BUSY_LABELS = { steer: 'Steer', queue: 'Queue next', interrupt: 'Interrupt' } as const;

type Props = {
  server: Server;
  chatId: string;
  busy: boolean;
  bottomInset: number;
  target: RefObject<View | null>;
  onHeight: (h: number) => void;
  placeholder: string;
};

/**
 * The message box: text, attachments (uploaded as soon as they're picked), replies, voice notes
 * (hold the mic), the command palette, and what to do with a message sent while the agent works.
 */
const focusers = new Map<string, () => void>();

/** Put the cursor in a chat's message box, once a sheet that asked for it has closed. */
export function focusComposer(serverId: string, chatId: string) {
  setTimeout(() => focusers.get(draftKey(serverId, chatId))?.(), 320);
}

export function Composer({ server, chatId, busy, bottomInset, target, onHeight, placeholder }: Props) {
  const t = useTheme();
  const s = useStyles();
  const key = draftKey(server.id, chatId);
  const text = useApp((st) => st.drafts[key] ?? '');
  const files = useApp((st) => st.draftFiles[key]) ?? EMPTY;
  const replyTo = useApp((st) => st.replyTo[key]);
  const setDraft = useApp((st) => st.setDraft);
  const setReplyTo = useApp((st) => st.setReplyTo);
  const online = useApp((st) => st.runtime[server.id]?.status === 'online');
  const features = useApp((st) => st.runtime[server.id]?.info?.features);
  const busyMode = usePrefs((st) => st.prefs.busyMode);
  const updatePrefs = usePrefs((st) => st.update);
  const [height, setHeight] = useState(MIN_INPUT);
  const [attachOpen, setAttachOpen] = useState(false);
  const [keepOriginal, setKeepOriginal] = useState(false);
  const [commands, setCommands] = useState<Command[]>([]);
  const input = useRef<TextInput>(null);
  const setText = (value: string) => setDraft(server.id, chatId, value);
  const uploads = features?.uploads !== false;
  const voice = features?.voice !== false;

  useEffect(() => {
    loadCommands(server).then(setCommands);
  }, [server]);

  // Choosing Reply puts the cursor straight in the box.
  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);

  // So "Edit" on a message can put the cursor here too.
  useEffect(() => {
    const focus = () => input.current?.focus();
    focusers.set(key, focus);
    return () => {
      if (focusers.get(key) === focus) focusers.delete(key);
    };
  }, [key]);

  // Keyboard: "/" from anywhere starts a command, Esc drops the reply or the half-typed command.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        input.current?.focus();
        if (!useApp.getState().drafts[key]) setDraft(server.id, chatId, '/');
      } else if (e.key === 'Escape') {
        const st = useApp.getState();
        if (st.replyTo[key]) setReplyTo(server.id, chatId, undefined);
        else if ((st.drafts[key] ?? '').startsWith('/') && !(st.drafts[key] ?? '').includes(' ')) setDraft(server.id, chatId, '');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [key, server.id, chatId, setDraft, setReplyTo]);

  // On the web, paste or drop files straight into the chat.
  useEffect(() => {
    if (Platform.OS !== 'web' || !uploads) return;
    const fromList = (list: FileList | null | undefined): PickedFile[] => Array.from(list ?? []).map((f) => ({
      uri: URL.createObjectURL(f), name: f.name || 'pasted-image.png', mime: f.type || 'application/octet-stream', size: f.size,
      file: f, isImage: f.type.startsWith('image/'),
    }));
    const onPaste = (e: ClipboardEvent) => {
      const picked = fromList(e.clipboardData?.files);
      if (!picked.length) return;
      e.preventDefault();
      attachFiles(server.id, chatId, picked);
    };
    const onDragOver = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    const onDrop = (e: DragEvent) => {
      const picked = fromList(e.dataTransfer?.files);
      if (!picked.length) return;
      e.preventDefault();
      attachFiles(server.id, chatId, picked);
    };
    document.addEventListener('paste', onPaste);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('paste', onPaste);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [server.id, chatId, uploads]);

  const ready = canSend(text, files);
  const uploading = files.some((f) => f.status === 'uploading' && !f.autoSend);
  const typedCommand = text.startsWith('/') && !text.includes(' ');
  const matches = typedCommand ? matchCommands(commands, text) : [];
  const showBusyModes = busy && !!text.trim() && !text.startsWith('/');

  const send = (value?: string) => {
    if (value !== undefined) {
      haptic.light();
      useApp.getState().sendMessage(server.id, chatId, value);
      return;
    }
    if (!ready) return;
    haptic.light();
    const prefix = showBusyModes && busyMode !== 'interrupt' ? `/${busyMode}` : '';
    sendDraft(server.id, chatId, text, prefix);
    setHeight(MIN_INPUT);
  };

  const pick = async (how: 'photos' | 'camera' | 'files') => {
    setAttachOpen(false);
    try {
      const picked = how === 'photos' ? await pickMedia() : how === 'camera' ? await takePhoto() : await pickFiles();
      if (picked === null) {
        useApp.getState().toast({ serverId: server.id, title: 'Camera not allowed', body: 'Allow camera access for Winglet in your phone settings to take photos.' });
        return;
      }
      if (picked.length) attachFiles(server.id, chatId, picked, { keepOriginal });
    } catch (e) {
      useApp.getState().toast({ serverId: server.id, title: "Couldn't attach", body: (e as Error).message });
    }
  };

  /** ↑ in an empty box brings back your last message to edit and send again. */
  const editLast = () => {
    // Read when asked, not subscribed to: the box doesn't re-render on every message.
    const messages = useApp.getState().runtime[server.id]?.messages[chatId] ?? [];
    let last;
    for (let i = messages.length - 1; i >= 0 && !last; i--) if (messages[i].role === 'user' && messages[i].text) last = messages[i];
    if (last) setText(last.text);
  };

  return (
    <View style={[s.wrap, { paddingBottom: Math.max(bottomInset, 10) }]} onLayout={(e) => onHeight(e.nativeEvent.layout.height)} pointerEvents="box-none">
      {matches.length ? (
        <Glass target={target} style={s.commands}>
          <ScrollView style={{ maxHeight: 316 }} keyboardShouldPersistTaps="handled" accessibilityLabel="Commands">
          {matches.map((c) => (
            <Pressable key={c.cmd} accessibilityRole="button" accessibilityLabel={`${c.cmd}: ${c.hint}`}
              style={({ pressed, hovered }: any) => [s.command, (pressed || hovered) && { backgroundColor: t.colors.pressed }]}
              onPress={() => (c.args ? setText(`${c.cmd} `) : send(c.cmd))}>
              <Text style={s.commandName} numberOfLines={1}>{c.cmd}{c.args ? <Text style={s.commandArgs}> {c.args}</Text> : null}</Text>
              <Text style={s.commandHint} numberOfLines={1}>{c.hint}</Text>
            </Pressable>
          ))}
          </ScrollView>
        </Glass>
      ) : null}
      {showBusyModes ? (
        <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} style={s.modes} accessibilityLabel="While it works">
          <Text style={s.modesLabel}>While it works:</Text>
          {(['steer', 'queue', 'interrupt'] as const).map((m) => (
            <Chip key={m} label={BUSY_LABELS[m]} selected={busyMode === m} onPress={() => updatePrefs({ busyMode: m })} />
          ))}
        </Animated.View>
      ) : null}
      {!online ? <Text style={s.offlineNote}>Offline. Messages you send are queued and go out when {server.bot.title} is back.</Text> : null}
      <Glass target={target} style={s.box} intensity={50}>
        {replyTo ? (
          <View style={s.reply}>
            <View style={s.replyBar} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.replyWho}>Replying to {replyTo.role === 'bot' ? server.bot.title : 'yourself'}</Text>
              <Text style={s.replyText} numberOfLines={1}>{plainText(replyTo.text) || 'Attachment'}</Text>
            </View>
            <Tap accessibilityLabel="Cancel reply" onPress={() => setReplyTo(server.id, chatId, undefined)} style={s.trayX}><X size={16} color={t.colors.textSecondary} /></Tap>
          </View>
        ) : null}
        {files.filter((f) => !f.autoSend).length ? <Tray server={server} chatId={chatId} files={files.filter((f) => !f.autoSend)} /> : null}
        {files.some((f) => f.autoSend) ? (
          <View style={s.voiceSending}><ActivityIndicator size="small" color={t.colors.accent} /><Text style={s.replyText}>Sending voice note…</Text></View>
        ) : null}
        <View style={s.row}>
          {uploads ? (
            <Tap feedback="selection" accessibilityLabel="Attach photos or files" onPress={() => setAttachOpen(true)} style={s.attach} scaleTo={0.9}>
              <Plus size={22} color={t.colors.text} />
            </Tap>
          ) : <View style={{ width: 8 }} />}
          <TextInput
            ref={input}
            value={text}
            onChangeText={setText}
            placeholder={placeholder}
            placeholderTextColor={t.colors.textTertiary}
            multiline
            accessibilityLabel={placeholder}
            onContentSizeChange={(e) => setHeight(Math.min(150, Math.max(MIN_INPUT, e.nativeEvent.contentSize.height)))}
            style={[s.input, Platform.OS === 'web' ? { height } : null]}
            onKeyPress={(e: any) => {
              if (Platform.OS !== 'web') return;
              if (e.nativeEvent.key === 'Enter' && !e.nativeEvent.shiftKey) {
                e.preventDefault?.();
                send();
              } else if (e.nativeEvent.key === 'ArrowUp' && !text) {
                e.preventDefault?.();
                editLast();
              }
            }}
          />
          {busy && !text.trim() && !files.length ? (
            <Tap key="stop" feedback="light" accessibilityLabel="Stop the current task" onPress={() => send('/stop')} style={[s.sendBtn, s.stopBtn]}>
              <Animated.View entering={ZoomIn.duration(160)}><Square size={14} color={t.colors.text} fill={t.colors.text} /></Animated.View>
            </Tap>
          ) : !text.trim() && !files.length && voice ? (
            <VoiceButton server={server} chatId={chatId} />
          ) : (
            <Tap key="send" feedback="none" accessibilityLabel={uploading ? 'Waiting for uploads' : 'Send'} accessibilityState={{ disabled: !ready }}
              disabled={!ready} onPress={() => send()} scaleTo={0.9} style={[s.sendBtn, { backgroundColor: ready ? t.colors.accentFill : t.colors.surfaceSunken }]}>
              {uploading ? <ActivityIndicator size="small" color={t.colors.textSecondary} /> : (
                <ArrowUp size={20} color={ready ? t.colors.onAccent : t.colors.textTertiary} strokeWidth={2.5} />
              )}
            </Tap>
          )}
        </View>
      </Glass>
      <Sheet visible={attachOpen} onClose={() => setAttachOpen(false)} title="Attach">
        {Platform.OS !== 'web' ? <SheetAction icon={<Camera size={20} color={t.colors.text} />} label="Take a photo" onPress={() => pick('camera')} /> : null}
        <SheetAction icon={<ImagePlus size={20} color={t.colors.text} />} label="Photos and videos" onPress={() => pick('photos')} />
        <SheetAction icon={<FileText size={20} color={t.colors.text} />} label="Files" onPress={() => pick('files')} />
        <View style={s.keepRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.keepTitle}>Send full-size originals</Text>
            <Text style={s.keepText}>Off: photos are resized and their location data removed.</Text>
          </View>
          <Toggle label="Send full-size originals" value={keepOriginal} onValueChange={setKeepOriginal} />
        </View>
      </Sheet>
    </View>
  );
}

const EMPTY: DraftFile[] = [];

/** Attached files above the text: thumbnails with upload progress, remove, and retry. */
function Tray({ server, chatId, files }: { server: Server; chatId: string; files: DraftFile[] }) {
  const t = useTheme();
  const s = useStyles();
  return (
    <View style={s.tray}>
      {files.map((f) => (
        <Animated.View key={f.localId} entering={ZoomIn.duration(220).easing(easeOut)} exiting={FadeOut.duration(120)} style={s.trayItem}
          accessibilityLabel={`${f.name}, ${f.status === 'uploading' ? `uploading ${Math.round(f.progress * 100)}%` : f.status}`}>
          {f.previewUri ? <Image source={{ uri: f.previewUri }} style={s.thumb} contentFit="cover" /> : (
            <View style={[s.thumb, s.thumbFile]}>
              <FileText size={18} color={t.colors.onAccentSoft} />
              <Text style={s.thumbName} numberOfLines={2}>{f.name}</Text>
            </View>
          )}
          {f.status === 'uploading' ? (
            <View style={s.progress}><View style={[s.progressFill, { width: `${Math.max(6, f.progress * 100)}%` }]} /></View>
          ) : null}
          {f.status === 'failed' ? (
            <Tap accessibilityLabel={`Retry ${f.name}. ${f.error ?? ''}`} onPress={() => retryFile(server.id, chatId, f.localId)} style={s.failed}>
              <RotateCcw size={18} color={t.colors.onAccent} />
            </Tap>
          ) : null}
          <Tap accessibilityLabel={`Remove ${f.name}`} onPress={() => removeFile(server.id, chatId, f.localId)} style={s.remove}>
            <X size={12} color={t.colors.onAccent} strokeWidth={3} />
          </Tap>
        </Animated.View>
      ))}
    </View>
  );
}

/**
 * Hold to record a voice note, release to send, slide left to cancel. Hermes transcribes it with
 * its own speech-to-text, the same as a voice note from Telegram.
 */
function VoiceButton({ server, chatId }: { server: Server; chatId: string }) {
  const t = useTheme();
  const s = useStyles();
  const reduced = useReducedMotion();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 200);
  const [recording, setRecording] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const startedAt = useRef(0);
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (!recording || reduced) return;
    pulse.value = withRepeat(withSequence(withTiming(0.35, { duration: 500 }), withTiming(1, { duration: 500 })), -1);
    return () => cancelAnimation(pulse);
  }, [recording, reduced, pulse]);
  const dot = useAnimatedStyle(() => ({ opacity: pulse.value }));

  const start = async () => {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      useApp.getState().toast({ serverId: server.id, title: 'Microphone not allowed', body: 'Allow microphone access for Winglet to send voice notes.' });
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    startedAt.current = Date.now();
    setRecording(true);
    haptic.light();
  };

  const finish = async (cancel: boolean) => {
    if (!startedAt.current) return;
    const held = Date.now() - startedAt.current;
    startedAt.current = 0;
    setRecording(false);
    setCancelling(false);
    try { await recorder.stop(); } catch { /* not started */ }
    setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    if (cancel || held < 600 || !recorder.uri) {
      if (!cancel && held < 600) useApp.getState().toast({ serverId: server.id, title: 'Hold to record', body: 'Keep holding the mic while you talk, then let go to send.' });
      return;
    }
    haptic.success();
    const name = `voice-note-${Date.now()}`;
    if (Platform.OS !== 'web') {
      attachFiles(server.id, chatId, [{ uri: recorder.uri, name: `${name}.m4a`, mime: 'audio/mp4' }], { voice: true });
      return;
    }
    // Browsers record WebM, except Safari, which records MP4.
    const blob = await (await fetch(recorder.uri)).blob();
    const mime = blob.type.split(';')[0] || 'audio/webm';
    attachFiles(server.id, chatId, [{ uri: recorder.uri, name: `${name}.${mime.includes('mp4') ? 'm4a' : 'webm'}`, mime, file: blob }], { voice: true });
  };

  const gesture = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .onBegin(() => { start(); })
    .onUpdate((e) => setCancelling(e.translationX < -80))
    .onFinalize((e) => { finish(e.translationX < -80); });

  return (
    <>
      {recording ? (
        <Animated.View entering={FadeIn.duration(120)} style={s.recording} pointerEvents="none">
          <Animated.View style={[s.recDot, dot]} />
          <Text style={s.recTime}>{formatDuration(state.durationMillis ?? 0)}</Text>
          <Text style={[s.recHint, cancelling && { color: t.colors.danger }]}>{cancelling ? 'Release to cancel' : '‹ Slide to cancel'}</Text>
        </Animated.View>
      ) : null}
      <GestureDetector gesture={gesture}>
        <View accessible accessibilityRole="button" accessibilityLabel="Hold to record a voice note"
          style={[s.sendBtn, { backgroundColor: recording ? t.colors.danger : t.colors.surfaceSunken }, recording && { transform: [{ scale: 1.15 }] }]}>
          <Mic size={20} color={recording ? t.colors.onDanger : t.colors.text} />
        </View>
      </GestureDetector>
    </>
  );
}

const useStyles = makeStyles((t) => ({
  wrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 10, paddingTop: 6 },
  box: { borderRadius: t.radius.xl, maxWidth: 820, width: '100%', alignSelf: 'center', overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, paddingLeft: 6, paddingRight: 6, paddingVertical: 6 },
  attach: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.surfaceSunken },
  input: {
    flex: 1, ...t.type.body, color: t.colors.text, paddingTop: 9, paddingBottom: 9, paddingHorizontal: 6, maxHeight: 150,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  sendBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  stopBtn: { backgroundColor: t.colors.surfaceSunken, borderWidth: 1, borderColor: t.colors.borderStrong },
  offlineNote: { ...t.type.caption, color: t.colors.warning, marginBottom: 6, marginLeft: 12, maxWidth: 820, alignSelf: 'center', width: '100%' },
  commands: { borderRadius: t.radius.lg, marginBottom: 8, paddingVertical: 4, maxWidth: 820, width: '100%', alignSelf: 'center' },
  command: { justifyContent: 'center', gap: 1, paddingHorizontal: 16, paddingVertical: 7, minHeight: 52 },
  commandName: { fontFamily: t.fonts.bold, fontSize: 15, color: t.colors.text },
  commandArgs: { fontFamily: t.fonts.regular, color: t.colors.textTertiary },
  commandHint: { ...t.type.caption, color: t.colors.textSecondary },
  modes: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8, maxWidth: 820, width: '100%', alignSelf: 'center', flexWrap: 'wrap' },
  modesLabel: { ...t.type.caption, color: t.colors.textSecondary, marginRight: 2 },
  reply: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 14, paddingRight: 6, paddingTop: 10 },
  replyBar: { width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: t.colors.accent },
  replyWho: { ...t.type.caption, fontFamily: t.fonts.semibold, color: t.colors.accent },
  replyText: { ...t.type.caption, color: t.colors.textSecondary },
  voiceSending: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 10 },
  tray: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 10, paddingTop: 10 },
  trayItem: { width: 72, height: 72 },
  thumb: { width: 72, height: 72, borderRadius: 14, backgroundColor: t.colors.surfaceSunken, overflow: 'hidden' },
  thumbFile: { alignItems: 'center', justifyContent: 'center', padding: 6, gap: 4 },
  thumbName: { fontFamily: t.fonts.medium, fontSize: 10, color: t.colors.textSecondary, textAlign: 'center' },
  progress: { position: 'absolute', left: 8, right: 8, bottom: 8, height: 4, borderRadius: 2, backgroundColor: t.colors.overlay, overflow: 'hidden' },
  progressFill: { height: 4, backgroundColor: t.colors.accent },
  failed: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.overlay },
  remove: { position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.textSecondary, borderWidth: 2, borderColor: t.colors.surface },
  trayX: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  recording: {
    position: 'absolute', left: 6, top: 6, bottom: 6, right: 52, flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, borderRadius: t.radius.pill, backgroundColor: t.colors.surfaceRaised, zIndex: 2,
  },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: t.colors.danger },
  recTime: { ...t.type.bodyStrong, color: t.colors.text, fontVariant: ['tabular-nums'] },
  recHint: { ...t.type.caption, color: t.colors.textSecondary, flex: 1, textAlign: 'right' },
  keepRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 12, marginTop: 4 },
  keepTitle: { ...t.type.body, fontFamily: t.fonts.medium, color: t.colors.text },
  keepText: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textSecondary, marginTop: 2 },
}));
