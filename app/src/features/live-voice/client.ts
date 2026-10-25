import { api, ApiError, botPath } from '../../lib/api';
import type { Server } from '../../lib/types';
import type { VoiceSession } from './engine';

export type Recording = { uri?: string; blob?: Blob; mime: string; durationMs: number; hasSpeech: boolean; dispose: () => void };
export class VoiceClient {
  constructor(readonly server: Server, readonly chatId: string) {}
  async open(signal?: AbortSignal): Promise<VoiceSession> {
    const s = await api<any>(this.server, '/api/voice/sessions', { method: 'POST', body: JSON.stringify({ chat_id: this.chatId }), signal });
    return { id: s.session_id, token: s.token, expiresAt: s.expires_at * 1000, chatId: s.chat_id,
      sttProvider: s.stt.provider || 'Configured speech-to-text', ttsProvider: s.tts.provider || 'Configured text-to-speech' };
  }
  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return api<T>(this.server, path, { method: 'POST', body: JSON.stringify(body), signal, timeoutMs: 65000 });
  }
  async transcribe(s: VoiceSession, turn: string, utterance: string, recording: Recording, signal: AbortSignal) {
    const form = new FormData();
    for (const [k, v] of Object.entries({ session_id: s.id, token: s.token, turn_id: turn, utterance_id: utterance, duration_ms: String(recording.durationMs) })) form.append(k, v);
    if (recording.blob) form.append('audio', recording.blob, recording.mime.includes('mp4') ? 'voice.m4a' : 'voice.webm');
    else form.append('audio', { uri: recording.uri, name: 'voice.m4a', type: recording.mime } as any);
    return api<{ transcript: string; no_speech: boolean; seq: number }>(this.server, '/api/voice/transcribe',
      { method: 'POST', body: form, timeoutMs: 65000, signal });
  }
  async speak(s: VoiceSession, turn: string, message: string, text: string, signal: AbortSignal) {
    const r = await this.post<{ url: string }>('/api/voice/speak', { session_id: s.id, token: s.token, turn_id: turn, message_id: message, text }, signal);
    // Signed URLs contain no bearer secret. The bot query preserves request scope.
    return this.server.url + botPath(this.server, r.url);
  }
  async stop(s: VoiceSession, turn: string, generation = false) {
    const r = await this.post<{ stopped: boolean; generation_stopped?: boolean }>(`/api/voice/sessions/${s.id}/stop`, { token: s.token, turn_id: turn, stop_generation: generation });
    if (!r.stopped || (generation && r.generation_stopped !== true)) throw new Error('The server did not acknowledge interruption.');
  }
  async end(s: VoiceSession) {
    try { await this.post(`/api/voice/sessions/${s.id}/end`, { token: s.token }); }
    catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e; }
  }
}

/** Retry only explicit backpressure, while this exact turn remains active. Never retry a lost request. */
export async function backpressure<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return await operation(); } catch (e) {
      if (!(e instanceof ApiError && e.status === 429) || attempt >= 3) throw e;
      const delay = Math.max(250, Math.min(3000, Number(e.data?.retry_after_ms) || 800));
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new Error('Cancelled')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
}
