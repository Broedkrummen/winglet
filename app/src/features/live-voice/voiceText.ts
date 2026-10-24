/**
 * Turning a reply into something worth hearing, and a spoken utterance into a command.
 *
 * Adapted from Herald's `shared/core/src/commonMain/kotlin/dev/hermeskotlin/core/voice/Speech.kt`
 * (MIT). The behaviour is deliberately close: code, links, file chips, tables and emoji are
 * silence; addresses and bullets don't get read out; a reply is cut at sentence ends so the first
 * piece can be spoken while the rest is still being synthesized.
 */

export const MAX_SPOKEN_CHARS = 1200;
/** The first piece stays short so speaking starts sooner. */
export const FIRST_CHUNK_CHARS = 160;
export const SPEECH_CHUNK_CHARS = 400;

const FENCED_CODE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE = /`([^`]+)`/g;
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)]+)\)/g;
const HTML = /<[^>]+>/g;
const URL = /\b(?:https?|file):\/\/\S+/gi;
const MEDIA_PATH = /[ \t]*MEDIA:\S+?(?=[.,;:!?)\]]*(?:\s|$))/g;
const LINE_FINAL_COLON = /:\s*$/gm;
const HEADING = /^#{1,6}\s+/gm;
const BULLET = /^\s*[-+*]\s+/gm;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm;
const TABLE_ROW = /^\s*\|.*\|\s*$/gm;
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]+/gu;
const MARKUP = /[*_~>#|]/g;
const WHITESPACE = /\s+/g;

/**
 * A reply as it should sound. Code, URLs, file chips, tables and emoji are silence rather than
 * read out symbol by symbol. Returns an empty string when there is nothing to say.
 */
export function speakableText(markdown: string): string {
  return markdown
    .replace(FENCED_CODE, '')
    .replace(TABLE_RULE, '')
    .replace(TABLE_ROW, '')
    .replace(LINE_FINAL_COLON, '.')
    .replace(IMAGE, ' $1 ')
    .replace(MARKDOWN_LINK, '$1')
    .replace(INLINE_CODE, '$1')
    .replace(HTML, ' ')
    .replace(URL, '')
    .replace(MEDIA_PATH, '')
    .replace(EMOJI, ' ')
    .replace(HEADING, '')
    .replace(BULLET, '')
    .replace(MARKUP, '')
    .replace(WHITESPACE, ' ')
    .trim();
}

/** A hard cap, applied only where speech starts: the panel still shows the whole reply. */
export function clipSpoken(text: string, max = MAX_SPOKEN_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.slice(0, max);
  // Prefer a sentence end inside the cap, then a word end, over cutting mid-word.
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence > max * 0.6) return { text: cut.slice(0, sentence + 1).trim(), truncated: true };
  const space = cut.lastIndexOf(' ');
  return { text: (space > max * 0.6 ? cut.slice(0, space) : cut).trim(), truncated: true };
}

/**
 * Cuts `text` into pieces of at most about `maxChars`, at sentence ends where possible, so the
 * first piece can be spoken while the rest are still being synthesized. A single sentence longer
 * than the limit is split at word boundaries as a last resort: the server caps every request, and
 * a four-hundred-character request is a better gap than a failed one.
 */
export function speechChunks(text: string, maxChars = SPEECH_CHUNK_CHARS, firstChars = FIRST_CHUNK_CHARS): string[] {
  const sentences = String(text || '')
    .match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  const pieces = sentences.length ? sentences : [String(text || '').trim()].filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const sentence of pieces) {
    const limit = chunks.length === 0 ? Math.max(40, firstChars) : Math.max(40, maxChars);
    if (current && current.length + sentence.length + 1 > limit) {
      chunks.push(current);
      current = '';
    }
    if (sentence.length > limit) {
      if (current) { chunks.push(current); current = ''; }
      for (const part of splitLong(sentence, limit)) chunks.push(part);
      continue;
    }
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) chunks.push(current);
  return chunks.filter(Boolean);
}

function splitLong(text: string, limit: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const cut = rest.lastIndexOf(' ', limit);
    const at = cut > limit * 0.5 ? cut : limit;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

const STOP_PHRASES = new Set([
  'stop', 'stop listening', 'stop it', 'stop please', 'please stop', 'stop stop', 'that is all', "that's all",
  'thats all', 'never mind', 'nevermind', 'end conversation', 'end the conversation', 'goodbye', 'good bye',
  'bye', 'cancel',
]);
const ADDRESSES = ['hey hermes', 'hermes', 'okay', 'ok', 'hey'];
const PUNCTUATION = /[^\p{L}\p{N}\s']+/gu;
const WHITESPACE_ANY = /\s+/g;

/**
 * A whole utterance that only says "stop" (or "never mind", "goodbye", …), optionally addressed
 * to the assistant, ends the conversation instead of being sent. "Stop the container" is a real
 * request, not a stop command — the same distinction Herald makes.
 */
export function isVoiceStopCommand(transcript: string, assistant = 'hermes'): boolean {
  let text = normalize(transcript);
  const names = [assistant, ...assistant.split(/\s+/), ...ADDRESSES]
    .map((name) => normalize(name))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const prefix of names) {
    if (text === prefix) return false;
    if (text.startsWith(`${prefix} `)) { text = text.slice(prefix.length + 1).trim(); break; }
  }
  return STOP_PHRASES.has(text) || STOP_PHRASES.has(text.replace(/'/g, ''));
}

function normalize(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(PUNCTUATION, ' ')
    .replace(WHITESPACE_ANY, ' ')
    .trim();
}
