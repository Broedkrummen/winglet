import {sha256} from '@noble/hashes/sha2.js';
import type {Message, ReplyRef} from '../../lib/types';
export type QuoteAnchor = {
  v: 1; message_id: string; chat_id: string; start: number; end: number; text: string; source_hash: string;
};
export const MAX_QUOTE = 4000;
export function sourceHash(text: string): string {
  return Array.from(sha256(new TextEncoder().encode(text)), byte => byte.toString(16).padStart(2,'0')).join('');
}
export function canQuote(message: Message): boolean {
  return message.role === 'bot' && message.status === 'final' && !!message.text.trim()
    && !message.meta?.activity && !message.meta?.hidden && !message.meta?.picker && !message.meta?.inbox_id;
}
function splitsSurrogate(text: string, index: number): boolean {
  return index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index-1]) && /[\uDC00-\uDFFF]/.test(text[index]);
}
export function makeAnchor(message: Message, start: number, end: number): QuoteAnchor {
  if (!canQuote(message)) throw new Error('Choose a completed assistant reply.');
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > message.text.length || start >= end
    || end-start > MAX_QUOTE || splitsSurrogate(message.text,start) || splitsSurrogate(message.text,end)) throw new Error('Select 1–4000 complete characters.');
  const text = message.text.slice(start,end);
  if (!text.trim()) throw new Error('Select some text from the reply.');
  return {v:1,message_id:message.id,chat_id:message.chat_id,start,end,text,source_hash:sourceHash(message.text)};
}
export function anchorValid(message: Message | undefined, anchor: QuoteAnchor): boolean {
  if (!message || message.id !== anchor.message_id || message.chat_id !== anchor.chat_id) return false;
  try { const current=makeAnchor(message,anchor.start,anchor.end); return current.text===anchor.text && current.source_hash===anchor.source_hash; } catch { return false; }
}
export function quoteRef(anchor: QuoteAnchor): ReplyRef {
  return {id:anchor.message_id,role:'bot',text:anchor.text,quote:anchor};
}
export function occurrences(source: string, quote: string): number[] {
  if (!quote || quote.length > MAX_QUOTE || !quote.trim()) return [];
  const out:number[]=[];
  for(let at=source.indexOf(quote);at>=0 && out.length<100;at=source.indexOf(quote,at+1)) out.push(at);
  return out;
}

