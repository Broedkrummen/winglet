import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { attachFiles } from './attach';
import { recordingMode } from './audioMode';
import { haptic } from './haptics';
import { sound } from './sounds';
import { useApp } from './store';
import { voiceSession } from './voiceSession';

/**
 * Hold-to-talk: start records, finish sends it to the chat as a voice note (Hermes transcribes it with its
 * own speech-to-text), unless cancelled or shorter than 600 ms. The composer's mic and the tab bar's pet use it.
 */
export function useVoiceNote(serverId: string, chatId: () => string, onSent?: () => void, prepareChat?: () => Promise<string | null>, onBeforeSend?: (chatId: string) => void) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 200);
  const [recording, setRecording] = useState(false);
  // Read when used, so the session (made once) always sends to the current chat and calls the current onSent.
  const latest = useRef({ serverId, chatId, onSent, prepareChat, onBeforeSend });
  latest.current = { serverId, chatId, onSent, prepareChat, onBeforeSend };
  const toast = (title: string, body: string) => useApp.getState().toast({ serverId: latest.current.serverId, title, body });

  const session = useRef(voiceSession({
    permission: async () => (await requestRecordingPermissionsAsync()).granted,
    begin: async () => {
      await recordingMode(true);
      await recorder.prepareToRecordAsync();
      recorder.record();
    },
    stop: async () => {
      setRecording(false);
      try { await recorder.stop(); } finally { recordingMode(false).catch(() => undefined); }
      return recorder.uri;
    },
    now: () => Date.now(),
    started: () => { setRecording(true); haptic.light(); },
    denied: () => toast('Microphone not allowed', 'Allow microphone access for Winglet to send voice notes.'),
    tooShort: () => toast('Hold to record', 'Keep holding while you talk, then let go to send.'),
    failed: () => toast("Couldn't record", 'The microphone is busy or unavailable. Try again in a moment.'),
    send: (uri) => { send(uri).catch(() => toast("Couldn't send voice note", 'Your recording could not be prepared. Please try again.')); },
  })).current;

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => { if (state !== 'active') session.finish(true); });
    return () => { sub.remove(); session.finish(true); };
  }, [session, serverId]);

  const send = async (uri: string) => {
    const { serverId: id, chatId: chat, onSent: done, prepareChat: prepare, onBeforeSend: before } = latest.current;
    const destination = prepare ? await prepare() : chat();
    if (!destination) return;
    before?.(destination);
    haptic.success();
    sound.sent();
    const name = `voice-note-${Date.now()}`;
    if (Platform.OS !== 'web') {
      attachFiles(id, destination, [{ uri, name: `${name}.m4a`, mime: 'audio/mp4' }], { voice: true });
    } else {
      // Browsers record WebM, except Safari, which records MP4.
      const blob = await (await fetch(uri)).blob();
      const mime = blob.type.split(';')[0] || 'audio/webm';
      attachFiles(id, destination, [{ uri, name: `${name}.${mime.includes('mp4') ? 'm4a' : 'webm'}`, mime, file: blob }], { voice: true });
    }
    done?.();
  };

  return { recording, durationMs: state.durationMillis ?? 0, start: session.start, finish: session.finish };
}
