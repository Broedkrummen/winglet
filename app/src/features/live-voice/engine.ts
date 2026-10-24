/**
 * The turn-based hands-free voice loop, as a pure state machine.
 *
 * One turn is one thing you said and the reply to it. Each recording inside a turn has its own
 * utterance id. The engine never talks to the network or the microphone itself: it returns
 * effects, the hook performs them, and every effect carries the generation it was created in so a
 * late transcription, synthesis or playback callback cannot resurrect an interrupted turn.
 *
 * This is deliberately not full-duplex: there is no listening while speaking and no acoustic
 * barge-in. Interruption is an explicit action, and it always goes through the same cancellation
 * path as the Stop button in the chat.
 */

import { clipSpoken, isVoiceStopCommand, MAX_SPOKEN_CHARS, speakableText } from './voiceText';

export type VoicePhase =
  | 'idle' | 'connecting' | 'listening' | 'transcribing' | 'thinking' | 'speaking'
  | 'interrupted' | 'reconnecting' | 'error' | 'ended';

export type VoiceTurnStatus = 'listening' | 'transcribing' | 'waiting' | 'speaking' | 'done' | 'failed' | 'silent' | 'paused' | 'interrupted';

export type VoiceTurn = {
  id: string;
  startedAt: number;
  userText: string;
  /** What the panel shows for the reply: the speakable part, not the raw markdown. */
  replyText: string;
  status: VoiceTurnStatus;
  messageId?: string;
  /** The clipped text to synthesize when the user asks to hear the reply again. */
  speechText?: string;
  truncated?: boolean;
};

export type VoiceSession = {
  id: string;
  token: string;
  expiresAt: number;
  chatId: string;
  sttProvider: string;
  ttsProvider: string;
};

export type VoiceErrorCode = 'session' | 'capture' | 'permission' | 'transcription' | 'send' | 'speech' | 'offline' | 'unsupported';
export type VoiceRetry = 'session' | 'transcribe' | 'speak' | 'listen' | 'none';

export type VoiceError = { code: VoiceErrorCode; message: string; retry: VoiceRetry };

export type VoiceState = {
  phase: VoicePhase;
  session: VoiceSession | null;
  muted: boolean;
  turns: VoiceTurn[];
  turnId: string | null;
  utteranceId: string | null;
  /** The status line: "Listening…", "Transcribing…", the transcript after it is sent. */
  caption: string;
  /** A partial transcript, replaced in place. */
  partial: string;
  error: VoiceError | null;
  /** A quiet instruction after a pause, reconnect or interruption. */
  note: string;
  generation: number;
};

export type VoiceEffect =
  | { type: 'openSession'; gen: number }
  | { type: 'listen'; gen: number; turnId: string; utteranceId: string; delayMs: number }
  | { type: 'transcribe'; gen: number; turnId: string; utteranceId: string; durationMs: number }
  | { type: 'send'; gen: number; turnId: string; text: string; clientId: string }
  | { type: 'speak'; gen: number; turnId: string; messageId: string; text: string; truncated: boolean }
  | { type: 'stopSpeech' }
  | { type: 'cancelCapture' }
  | { type: 'cancelTurn'; turnId: string }
  | { type: 'stopGeneration'; turnId: string }
  | { type: 'endSession' };

export type UtteranceOutcome =
  | { kind: 'audio'; durationMs: number; hasSpeech: boolean }
  | { kind: 'transcript'; text: string; durationMs: number }
  | { kind: 'silence'; durationMs: number };

type Options = {
  assistantName?: string;
  now?: () => number;
  newId?: (prefix: string) => string;
  maxTurns?: number;
  maxSeen?: number;
  maxSpoken?: number;
  silenceRetries?: number;
};

const INITIAL: Omit<VoiceState, 'generation'> = {
  phase: 'idle', session: null, muted: false, turns: [], turnId: null, utteranceId: null,
  caption: '', partial: '', error: null, note: '',
};

export class VoiceEngine {
  private state: VoiceState;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly makeId: (prefix: string) => string;
  private readonly assistantName: string;
  private readonly maxTurns: number;
  private readonly maxSeen: number;
  private readonly maxSpoken: number;
  private readonly silenceRetries: number;
  private readonly seenUtterances = new Set<string>();
  private readonly spokenMessages = new Set<string>();
  private lastPartial = new Map<string, number>();
  private pendingStart = false;
  private silenceStreak = 0;

  constructor(options: Options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.makeId = options.newId ?? ((prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
    this.assistantName = options.assistantName || 'hermes';
    this.maxTurns = options.maxTurns ?? 8;
    this.maxSeen = options.maxSeen ?? 64;
    this.maxSpoken = options.maxSpoken ?? 64;
    this.silenceRetries = options.silenceRetries ?? 2;
    this.state = { ...INITIAL, generation: 0 };
  }

  snapshot(): VoiceState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get generation(): number {
    return this.state.generation;
  }

  get turn(): VoiceTurn | null {
    const id = this.state.turnId;
    return id ? this.state.turns.find((t) => t.id === id) ?? null : null;
  }

  /** The panel opened: make a session, but never start the microphone by itself. */
  open(): VoiceEffect[] {
    const generation = this.state.generation + 1;
    this.set({ ...INITIAL, phase: 'connecting', muted: this.state.muted, generation, caption: 'Connecting…' });
    this.pendingStart = false;
    this.silenceStreak = 0;
    return [{ type: 'openSession', gen: generation }];
  }

  sessionReady(session: VoiceSession, options: { reconnected?: boolean } = {}): VoiceEffect[] {
    if (options.reconnected) {
      this.set({
        phase: 'idle', session, error: null, caption: 'Reconnected', note: 'Reconnected — tap to speak again.',
        turnId: null, utteranceId: null, partial: '',
      });
      this.pendingStart = false;
      return [];
    }
    this.set({ session, error: null });
    if (this.pendingStart) {
      this.pendingStart = false;
      return this.beginTurn(0);
    }
    this.set({ phase: 'idle', caption: 'Ready when you are', note: '' });
    return [];
  }

  sessionFailed(message: string): VoiceEffect[] {
    this.pendingStart = false;
    this.set({ phase: 'error', session: null, error: { code: 'session', retry: 'session', message }, note: '' });
    return [];
  }

  /** The microphone starts only from this explicit action. */
  startListening(): VoiceEffect[] {
    if (this.state.phase === 'ended') return [];
    if (this.state.muted) {
      this.set({ note: 'Microphone muted. Unmute to speak.' });
      return [];
    }
    if (this.state.phase === 'connecting') { this.pendingStart = true; return []; }
    if (['listening', 'transcribing', 'thinking', 'speaking'].includes(this.state.phase)) return [];
    if (!this.state.session) {
      const generation = this.state.generation + 1;
      this.pendingStart = true;
      this.set({ phase: 'connecting', generation, caption: 'Connecting…', error: null, note: '', partial: '' });
      return [{ type: 'openSession', gen: generation }];
    }
    return this.beginTurn(0);
  }

  /** A recording ended. Silence never reaches the network. */
  utteranceDone(input: { turnId: string; utteranceId: string; outcome: UtteranceOutcome }): VoiceEffect[] {
    if (this.state.phase !== 'listening') return [];
    if (this.state.turnId !== input.turnId || this.state.utteranceId !== input.utteranceId) return [];
    const turn = this.turn;
    if (!turn) return [];
    const outcome = input.outcome;
    if (outcome.kind === 'silence' || (outcome.kind === 'transcript' && !outcome.text.trim())
      || (outcome.kind === 'audio' && !outcome.hasSpeech)) {
      return this.heardNothing(turn);
    }
    this.silenceStreak = 0;
    if (outcome.kind === 'transcript') {
      return this.transcriptReceived({
        turnId: input.turnId, utteranceId: input.utteranceId, text: outcome.text, final: true, noSpeech: false,
      });
    }
    turn.status = 'transcribing';
    this.set({ phase: 'transcribing', caption: 'Transcribing…', partial: '', error: null, note: '' });
    return [{
      type: 'transcribe', gen: this.state.generation, turnId: input.turnId, utteranceId: input.utteranceId,
      durationMs: outcome.durationMs,
    }];
  }

  /** Device dictation writes words as they are said; server transcription only sends the final one. */
  partialTranscript(input: { turnId: string; utteranceId: string; text: string; seq?: number }): VoiceEffect[] {
    if (this.state.turnId !== input.turnId || this.state.utteranceId !== input.utteranceId) return [];
    if (!['listening', 'transcribing'].includes(this.state.phase)) return [];
    if (input.seq !== undefined) {
      const key = `${input.turnId}:${input.utteranceId}`;
      const last = this.lastPartial.get(key);
      if (last !== undefined && input.seq <= last) return [];
      this.lastPartial.set(key, input.seq);
      while (this.lastPartial.size > this.maxSeen) this.lastPartial.delete(this.lastPartial.keys().next().value!);
    }
    const text = input.text.trim().slice(0, 8000);
    this.set({ partial: text, caption: text || 'Listening…' });
    return [];
  }

  transcriptReceived(input: {
    turnId: string; utteranceId: string; text: string; final: boolean; noSpeech?: boolean; seq?: number;
  }): VoiceEffect[] {
    if (this.state.turnId !== input.turnId || this.state.utteranceId !== input.utteranceId) return [];
    const turn = this.turn;
    if (!turn || !['listening', 'transcribing'].includes(this.state.phase)) return [];
    const key = `${input.turnId}:${input.utteranceId}`;
    if (!input.final) return this.partialTranscript(input);
    if (this.seenUtterances.has(key)) return [];
    this.remember(this.seenUtterances, key, this.maxSeen);
    const text = input.text.trim().slice(0, 8000);
    if (input.noSpeech || !text) return this.heardNothing(turn);
    this.silenceStreak = 0;
    this.lastPartial.delete(key);
    if (isVoiceStopCommand(text, this.assistantName)) {
      turn.status = 'done';
      this.pendingStart = false;
      const generation = this.state.generation + 1;
      this.set({
        phase: 'ended', generation, caption: 'Voice session ended', note: 'Close the panel when you are ready.',
        turnId: null, utteranceId: null, partial: '', error: null,
      });
      return [{ type: 'stopSpeech' }, { type: 'endSession' }];
    }
    turn.userText = text;
    turn.status = 'waiting';
    this.set({ phase: 'thinking', caption: text, partial: '', error: null, note: '' });
    return [{
      type: 'send', gen: this.state.generation, turnId: turn.id, text, clientId: `voice-${turn.id}`,
    }];
  }

  transcriptionFailed(input: { turnId: string; utteranceId: string; message: string; busy?: boolean; expired?: boolean }): VoiceEffect[] {
    if (this.state.turnId !== input.turnId || this.state.utteranceId !== input.utteranceId) return [];
    const turn = this.turn;
    if (!turn) return [];
    if (input.busy) {
      this.set({ phase: 'transcribing', caption: 'Still transcribing…' });
      return [];
    }
    if (input.expired) return this.sessionLost(input.message || 'The voice session ended. Reconnecting…');
    turn.status = 'failed';
    this.set({
      phase: 'error', error: { code: 'transcription', retry: 'transcribe', message: input.message || 'Transcription failed. Try again.' },
      note: '',
    });
    return [];
  }

  captureFailed(message: string, code: VoiceErrorCode = 'capture'): VoiceEffect[] {
    const turn = this.turn;
    if (turn && !turn.userText) {
      turn.status = 'failed';
      this.set({ turns: this.state.turns.filter((t) => t.id !== turn.id) });
    }
    this.pendingStart = false;
    this.silenceStreak = 0;
    this.set({
      phase: 'error', turnId: null, utteranceId: null, partial: '', caption: '',
      error: { code, retry: 'listen', message: message || 'The microphone is unavailable.' }, note: '',
    });
    return [];
  }

  /** An authoritative chat message. Only a final reply created after the turn began may be spoken. */
  replyMessage(input: { id: string; text: string; createdAtMs: number; final: boolean }): VoiceEffect[] {
    if (!input.final) return [];
    if (this.state.phase !== 'thinking') return [];
    const turn = this.turn;
    if (!turn || turn.status !== 'waiting') return [];
    if (input.createdAtMs + 2500 < turn.startedAt) return [];
    if (this.spokenMessages.has(input.id)) return [];
    this.remember(this.spokenMessages, input.id, this.maxSpoken);
    const full = speakableText(input.text || '');
    const clipped = clipSpoken(full, MAX_SPOKEN_CHARS);
    turn.messageId = input.id;
    turn.speechText = clipped.text;
    turn.truncated = clipped.truncated;
    if (!clipped.text) {
      turn.replyText = speakableText(input.text || '') || 'Nothing to read aloud.';
      turn.status = 'done';
      return this.continueAfterTurn(120);
    }
    turn.replyText = clipped.text;
    turn.status = 'speaking';
    this.set({ phase: 'speaking', caption: 'Speaking…', note: '', error: null });
    return [{
      type: 'speak', gen: this.state.generation, turnId: turn.id, messageId: input.id,
      text: clipped.text, truncated: clipped.truncated,
    }];
  }

  /** The chat's copy of what was said wins over the local transcript when it arrives. */
  sentMessage(input: { clientId: string; text: string; failed?: boolean }): VoiceEffect[] {
    const turn = this.turn;
    if (!turn || input.clientId !== `voice-${turn.id}`) return [];
    if (input.text.trim() && input.text.trim() !== turn.userText) {
      turn.userText = input.text.trim();
      this.set({ caption: turn.userText });
    }
    if (input.failed) {
      turn.status = 'failed';
      this.set({
        phase: 'error', caption: '', error: { code: 'send', retry: 'listen', message: 'That message was not delivered. It is in the chat, where you can retry it.' },
      });
      return [];
    }
    return [];
  }

  speechFinished(turnId: string): VoiceEffect[] {
    if (this.state.phase !== 'speaking' || this.state.turnId !== turnId) return [];
    const turn = this.turn;
    if (turn) turn.status = 'done';
    return this.continueAfterTurn(350);
  }

  speechFailed(turnId: string, message: string): VoiceEffect[] {
    if (this.state.phase !== 'speaking' || this.state.turnId !== turnId) return [];
    const turn = this.turn;
    if (turn) turn.status = 'failed';
    this.set({
      phase: 'error', caption: '',
      error: { code: 'speech', retry: 'speak', message: message || 'The reply could not be read aloud.' },
    });
    return [];
  }

  /** The same transcript is already in the chat, but no reply arrived. */
  replyMissing(): VoiceEffect[] {
    if (this.state.phase !== 'thinking') return [];
    const turn = this.turn;
    if (!turn || turn.status !== 'waiting') return [];
    turn.status = 'failed';
    this.set({
      phase: 'error', caption: '', note: '',
      error: { code: 'send', retry: 'listen', message: 'No reply came. Your words are in the chat; tap to speak again.' },
    });
    return [];
  }

  retry(): VoiceEffect[] {
    const error = this.state.error;
    const turn = this.turn;
    if (error?.retry === 'transcribe' && this.state.turnId && this.state.utteranceId) {
      this.set({ phase: 'transcribing', caption: 'Transcribing…', error: null });
      return [{
        type: 'transcribe', gen: this.state.generation, turnId: this.state.turnId,
        utteranceId: this.state.utteranceId, durationMs: 0,
      }];
    }
    if (error?.retry === 'speak' && turn?.speechText && turn.messageId) {
      this.set({ phase: 'speaking', caption: 'Speaking…', error: null });
      return [{
        type: 'speak', gen: this.state.generation, turnId: turn.id, messageId: turn.messageId,
        text: turn.speechText, truncated: !!turn.truncated,
      }];
    }
    if (error?.retry === 'session') {
      const generation = this.state.generation + 1;
      this.set({ phase: 'connecting', generation, caption: 'Connecting…', error: null });
      this.pendingStart = true;
      return [{ type: 'openSession', gen: generation }];
    }
    this.set({ error: null });
    return this.startListening();
  }

  /** Manual barge-in, or the microphone's own Stop. Never starts the microphone again. */
  interrupt(): VoiceEffect[] {
    const phase = this.state.phase;
    if (['idle', 'ended', 'interrupted', 'reconnecting'].includes(phase)) return [];
    if (phase === 'connecting') {
      this.pendingStart = false;
      this.set({ phase: 'idle', caption: 'Cancelled', note: 'Tap to speak.', generation: this.state.generation + 1 });
      return [];
    }
    const turn = this.turn;
    const turnId = turn?.id;
    const cancellingGeneration = turn?.status === 'waiting';
    if (turn) turn.status = 'interrupted';
    const generation = this.state.generation + 1;
    this.pendingStart = false;
    this.set({
      phase: 'interrupted', generation, caption: 'Interrupted', note: 'Tap to speak again.',
      turnId: null, utteranceId: null, partial: '', error: null,
    });
    const effects: VoiceEffect[] = [{ type: 'stopSpeech' }, { type: 'cancelCapture' }];
    if (turnId && this.state.session) effects.push({ type: 'cancelTurn', turnId });
    if (turnId && cancellingGeneration) effects.push({ type: 'stopGeneration', turnId });
    return effects;
  }

  /** Backgrounding, a lock screen or a lost connection: cancel the turn, never replay it. */
  suspend(reason: 'background' | 'reconnect'): VoiceEffect[] {
    if (this.state.phase === 'ended') return [];
    const turn = this.turn;
    const turnId = turn?.id;
    if (turn && !turn.userText) turn.status = 'silent';
    else if (turn) turn.status = 'paused';
    const generation = this.state.generation + 1;
    this.pendingStart = false;
    const reconnect = reason === 'reconnect';
    this.set({
      phase: reconnect ? 'reconnecting' : 'idle', generation,
      caption: reconnect ? 'Reconnecting…' : 'Paused',
      note: reconnect ? 'Connection lost. Tap to continue when it is back.' : 'Paused — tap to speak again.',
      turnId: null, utteranceId: null, partial: '', error: null,
    });
    const effects: VoiceEffect[] = [{ type: 'stopSpeech' }, { type: 'cancelCapture' }];
    if (turnId && this.state.session) effects.push({ type: 'cancelTurn', turnId });
    if (reconnect) effects.push({ type: 'endSession' });
    return effects;
  }

  sessionLost(message = 'The voice session ended.'): VoiceEffect[] {
    const generation = this.state.generation + 1;
    this.pendingStart = false;
    this.set({
      phase: 'reconnecting', session: null, generation, caption: 'Reconnecting…',
      note: message, turnId: null, utteranceId: null, partial: '', error: null,
    });
    return [{ type: 'stopSpeech' }, { type: 'cancelCapture' }];
  }

  setMuted(muted: boolean): VoiceEffect[] {
    if (muted === this.state.muted) return [];
    const effects: VoiceEffect[] = [];
    if (muted) {
      const wasListening = this.state.phase === 'listening';
      const turn = this.turn;
      if (wasListening && turn && !turn.userText) {
        this.set({ turns: this.state.turns.filter((t) => t.id !== turn.id) });
      }
      if (wasListening) {
        this.pendingStart = false;
        this.set({
          phase: 'idle', generation: this.state.generation + 1, turnId: null, utteranceId: null, partial: '', caption: 'Microphone muted',
          note: 'Microphone muted.', muted: true,
        });
        effects.push({ type: 'cancelCapture' });
      } else {
        this.set({ muted: true, note: 'Microphone muted.' });
      }
    } else {
      this.set({ muted: false, note: 'Microphone on. Tap to speak.' });
    }
    return effects;
  }

  /** Closing the panel. A reply already being generated still lands in the chat as text. */
  end(): VoiceEffect[] {
    if (this.state.phase === 'ended') return [];
    const turn = this.turn;
    const effects: VoiceEffect[] = [{ type: 'stopSpeech' }, { type: 'cancelCapture' }];
    if (turn && this.state.session) effects.push({ type: 'cancelTurn', turnId: turn.id });
    if (this.state.session) effects.push({ type: 'endSession' });
    const generation = this.state.generation + 1;
    this.pendingStart = false;
    this.silenceStreak = 0;
    this.set({
      phase: 'ended', session: null, generation, caption: 'Voice session ended', note: '',
      turnId: null, utteranceId: null, partial: '', error: null,
    });
    return effects;
  }

  // -- internals -----------------------------------------------------------------------

  private beginTurn(delayMs: number): VoiceEffect[] {
    if (this.state.muted) {
      this.set({ phase: 'idle', note: 'Microphone muted.' });
      return [];
    }
    const generation = this.state.generation + 1;
    const now = this.now();
    const turn: VoiceTurn = {
      id: this.makeId('t'), startedAt: now, userText: '', replyText: '', status: 'listening',
    };
    const turns = [...this.state.turns, turn];
    while (turns.length > this.maxTurns) turns.shift();
    this.silenceStreak = 0;
    this.set({
      phase: 'listening', generation, turns, turnId: turn.id, utteranceId: this.makeId('u'),
      caption: 'Listening…', partial: '', error: null, note: '',
    });
    return [{
      type: 'listen', gen: generation, turnId: turn.id, utteranceId: this.state.utteranceId!,
      delayMs: Math.max(0, delayMs),
    }];
  }

  private continueAfterTurn(delayMs: number): VoiceEffect[] {
    if (this.state.muted) {
      this.set({ phase: 'idle', turnId: null, utteranceId: null, note: 'Microphone muted.', partial: '' });
      return [];
    }
    if (!this.state.session) {
      this.pendingStart = false;
      this.set({
        phase: 'error', turnId: null, utteranceId: null, note: '',
        error: { code: 'session', retry: 'session', message: 'The voice session ended. Reconnect to keep talking.' },
      });
      return [];
    }
    return this.beginTurn(delayMs);
  }

  private heardNothing(turn: VoiceTurn): VoiceEffect[] {
    this.silenceStreak += 1;
    this.lastPartial.delete(`${turn.id}:${this.state.utteranceId ?? ''}`);
    if (this.state.muted || this.silenceStreak >= this.silenceRetries) {
      turn.status = 'silent';
      const turns = this.state.turns.filter((t) => t.id !== turn.id);
      this.set({
        phase: 'idle', turns, turnId: null, utteranceId: null, partial: '', caption: '',
        note: "Didn't hear anything. Tap to speak again.", error: null,
      });
      return [];
    }
    const utteranceId = this.makeId('u');
    this.set({
      phase: 'listening', utteranceId, partial: '', caption: 'Still listening…', note: '', error: null,
    });
    return [{
      type: 'listen', gen: this.state.generation, turnId: turn.id, utteranceId, delayMs: 250,
    }];
  }

  private remember(set: Set<string>, value: string, max: number): void {
    set.add(value);
    while (set.size > max) {
      const first = set.values().next().value;
      if (first === undefined) break;
      set.delete(first);
    }
  }

  private set(patch: Partial<VoiceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/** The labels the panel uses, kept next to the phases so they cannot drift. */
export function phaseTitle(phase: VoicePhase): string {
  switch (phase) {
    case 'idle': return 'Ready when you are';
    case 'connecting': return 'Connecting…';
    case 'listening': return 'Listening…';
    case 'transcribing': return 'Transcribing…';
    case 'thinking': return 'Thinking…';
    case 'speaking': return 'Speaking…';
    case 'interrupted': return 'Interrupted';
    case 'reconnecting': return 'Reconnecting…';
    case 'error': return 'Something went wrong';
    case 'ended': return 'Voice session ended';
  }
}
