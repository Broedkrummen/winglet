import {
  RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState,
} from 'expo-audio';
import { useRef, useState } from 'react';
import { Platform } from 'react-native';
import { attachFiles } from './attach';
import { haptic } from './haptics';
import { sound } from './sounds';
import { useApp } from './store';

/**
 * Hold-to-talk: start records, finish sends it to the chat as a voice note (Hermes transcribes it with its
 * own speech-to-text), unless cancelled or shorter than 600 ms. The composer's mic and the tab bar's pet use it.
 */
export function useVoiceNote(serverId: string, chatId: () => string, onSent?: () => void) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 200);
  const [recording, setRecording] = useState(false);
  const startedAt = useRef(0);

  const start = async () => {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      useApp.getState().toast({ serverId, title: 'Microphone not allowed', body: 'Allow microphone access for Winglet to send voice notes.' });
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
    try { await recorder.stop(); } catch { /* not started */ }
    setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    if (cancel || held < 600 || !recorder.uri) {
      if (!cancel && held < 600) useApp.getState().toast({ serverId, title: 'Hold to record', body: 'Keep holding while you talk, then let go to send.' });
      return;
    }
    haptic.success();
    sound.sent();
    const name = `voice-note-${Date.now()}`;
    if (Platform.OS !== 'web') {
      attachFiles(serverId, chatId(), [{ uri: recorder.uri, name: `${name}.m4a`, mime: 'audio/mp4' }], { voice: true });
    } else {
      // Browsers record WebM, except Safari, which records MP4.
      const blob = await (await fetch(recorder.uri)).blob();
      const mime = blob.type.split(';')[0] || 'audio/webm';
      attachFiles(serverId, chatId(), [{ uri: recorder.uri, name: `${name}.${mime.includes('mp4') ? 'm4a' : 'webm'}`, mime, file: blob }], { voice: true });
    }
    onSent?.();
  };

  return { recording, durationMs: state.durationMillis ?? 0, start, finish };
}
