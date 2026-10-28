import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import { Lexer, type Token, type Tokens } from 'marked';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { Linking, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { haptic } from '../lib/haptics';
import { highlight, type SynKind } from '../lib/highlight';
import { makeStyles, useTheme } from '../lib/themeContext';
import { FIXED, type Theme } from '../lib/theme';
import { Check, ChevronsDownUp, ChevronsUpDown, Copy } from './icons';

type Props = {
  text: string;
  resolveUrl?: (url: string) => string;
  /** onAccent: white text, for your own message bubbles. */
  tone?: 'default' | 'onAccent' | 'muted';
  /** Text can be selected in place. Off in chat on phones, where a long press opens the message menu. */
  selectable?: boolean;
  compact?: boolean;
};

type Styles = ReturnType<typeof useStyles>;
type Ctx = { resolveUrl?: (url: string) => string; s: Styles; t: Theme; tone: NonNullable<Props['tone']>; sel: boolean };

/** Code longer than this folds to its first lines, with a button to show the rest. */
const FOLD_LINES = 18;
const FOLDED_LINES = 12;

/** Chat-flavoured Markdown: paragraphs, headings, lists, highlighted code, quotes, tables, links, images. */
export const Markdown = memo(function Markdown({ text, resolveUrl, tone = 'default', selectable = true, compact = false }: Props) {
  const base = useStyles();
  const s = useMemo(() => compact ? { ...base, root: { ...base.root, gap: 5 }, p: { ...base.p, fontSize: 15, lineHeight: 21 },
    codeText: { ...base.codeText, fontSize: 12.5, lineHeight: 18 }, codeInline: { ...base.codeInline, fontSize: 12.5 }, list: { ...base.list, gap: 2 } } : base, [base, compact]);
  const t = useTheme();
  const ctx: Ctx = { resolveUrl, s, t, tone, sel: selectable };
  let tokens: Token[];
  try {
    tokens = new Lexer({ gfm: true, breaks: true }).lex(text || '');
  } catch {
    return <Text selectable={selectable} style={[s.p, toneStyle(ctx)]}>{text}</Text>;
  }
  // Each top-level block renders on its own: as a reply streams in, only the block still growing redraws.
  return <View style={s.root}>{tokens.map((token, i) => (token.type === 'space' ? null : <Block key={i} token={token} ctx={ctx} />))}</View>;
});

const Block = memo(function Block({ token, ctx }: { token: Token; ctx: Ctx }) {
  return <>{renderBlock(token, 0, ctx)}</>;
}, (a, b) => a.token.raw === b.token.raw && a.ctx.s === b.ctx.s && a.ctx.t === b.ctx.t && a.ctx.tone === b.ctx.tone
  && a.ctx.sel === b.ctx.sel && a.ctx.resolveUrl === b.ctx.resolveUrl);

function toneStyle(ctx: Ctx) {
  return ctx.tone === 'onAccent' ? ctx.s.onAccent : ctx.tone === 'muted' ? ctx.s.muted : null;
}

function renderBlocks(tokens: Token[], ctx: Ctx): ReactNode[] {
  return tokens.map((token, i) => renderBlock(token, i, ctx)).filter(Boolean);
}

function renderBlock(token: Token, key: number, ctx: Ctx): ReactNode {
  const { s } = ctx;
  const tone = toneStyle(ctx);
  switch (token.type) {
    case 'space':
      return null;
    case 'paragraph': {
      const t = token as Tokens.Paragraph;
      const onlyImage = t.tokens?.length === 1 && t.tokens[0].type === 'image';
      if (onlyImage) return <MdImage key={key} token={t.tokens[0] as Tokens.Image} ctx={ctx} />;
      return <Text key={key} selectable={ctx.sel} style={[s.p, tone]}>{renderInline(t.tokens ?? [], ctx)}</Text>;
    }
    case 'heading': {
      const t = token as Tokens.Heading;
      const size = t.depth === 1 ? 22 : t.depth === 2 ? 19 : 17;
      return (
        <Text key={key} selectable={ctx.sel} accessibilityRole="header" style={[s.h, tone, { fontSize: size, lineHeight: size * 1.3 }]}>
          {renderInline(t.tokens ?? [], ctx)}
        </Text>
      );
    }
    case 'code': {
      const t = token as Tokens.Code;
      return <CodeBlock key={key} code={t.text} lang={t.lang} ctx={ctx} />;
    }
    case 'blockquote': {
      const t = token as Tokens.Blockquote;
      return (
        <View key={key} style={s.quote}>
          <View style={[s.quoteBar, ctx.tone === 'onAccent' && { backgroundColor: FIXED.onAccentFaint }]} />
          <View style={{ flex: 1 }}>{renderBlocks(t.tokens ?? [], ctx)}</View>
        </View>
      );
    }
    case 'list': {
      const t = token as Tokens.List;
      const start = typeof t.start === 'number' ? t.start : 1;
      return (
        <View key={key} style={s.list}>
          {t.items.map((item, idx) => (
            <View key={idx} style={s.li}>
              <Text style={[s.bullet, tone]}>{item.task ? (item.checked ? '☑' : '☐') : t.ordered ? `${start + idx}.` : '•'}</Text>
              <View style={{ flex: 1 }}>
                {item.tokens.map((child, ci) =>
                  child.type === 'text' ? (
                    <Text key={ci} selectable={ctx.sel} style={[s.p, tone]}>{renderInline((child as Tokens.Text).tokens ?? [child], ctx)}</Text>
                  ) : (
                    renderBlock(child, ci, ctx)
                  ),
                )}
              </View>
            </View>
          ))}
        </View>
      );
    }
    case 'table': {
      const t = token as Tokens.Table;
      return (
        <ScrollView key={key} horizontal style={s.tableWrap} showsHorizontalScrollIndicator={false}>
          <View>
            <View style={[s.tr, s.thead]}>
              {t.header.map((cell, ci) => <Text key={ci} selectable={ctx.sel} style={[s.td, s.th]}>{renderInline(cell.tokens, ctx)}</Text>)}
            </View>
            {t.rows.map((row, ri) => (
              <View key={ri} style={[s.tr, ri === t.rows.length - 1 && { borderBottomWidth: 0 }]}>
                {row.map((cell, ci) => <Text key={ci} selectable={ctx.sel} style={s.td}>{renderInline(cell.tokens, ctx)}</Text>)}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    }
    case 'hr':
      return <View key={key} style={s.hr} />;
    case 'html':
    case 'text':
      return (
        <Text key={key} selectable={ctx.sel} style={[s.p, tone]}>
          {'tokens' in token && token.tokens ? renderInline(token.tokens, ctx) : (token as Tokens.Text).text}
        </Text>
      );
    default:
      return 'raw' in token ? <Text key={key} selectable={ctx.sel} style={[s.p, tone]}>{(token as Tokens.Generic).raw}</Text> : null;
  }
}

function renderInline(tokens: Token[], ctx: Ctx): ReactNode[] {
  const { s } = ctx;
  return tokens.map((token, i) => {
    switch (token.type) {
      case 'strong':
        return <Text key={i} style={[s.bold, toneStyle(ctx)]}>{renderInline((token as Tokens.Strong).tokens, ctx)}</Text>;
      case 'em':
        return <Text key={i} style={s.italic}>{renderInline((token as Tokens.Em).tokens, ctx)}</Text>;
      case 'del':
        return <Text key={i} style={s.strike}>{renderInline((token as Tokens.Del).tokens, ctx)}</Text>;
      case 'codespan':
        return <Text key={i} style={[s.codeInline, ctx.tone === 'onAccent' && s.codeInlineOnAccent]}>{decode((token as Tokens.Codespan).text)}</Text>;
      case 'br':
        return <Text key={i}>{'\n'}</Text>;
      case 'link': {
        const t = token as Tokens.Link;
        return (
          <Text key={i} accessibilityRole="link" style={[s.link, ctx.tone === 'onAccent' && s.linkOnAccent]} onPress={() => openLink(t.href)}>
            {renderInline(t.tokens ?? [], ctx)}
          </Text>
        );
      }
      case 'image': {
        const t = token as Tokens.Image;
        return <Text key={i} style={s.link} onPress={() => openLink(ctx.resolveUrl ? ctx.resolveUrl(t.href) : t.href)}>🖼 {t.text || 'image'}</Text>;
      }
      case 'escape':
      case 'text': {
        const t = token as Tokens.Text;
        if (t.tokens?.length) return <Text key={i}>{renderInline(t.tokens, ctx)}</Text>;
        return <Text key={i}>{decode(t.text)}</Text>;
      }
      default:
        return <Text key={i}>{decode((token as Tokens.Generic).raw ?? '')}</Text>;
    }
  });
}

/** A code block: syntax colours, copy, and long code folded until you ask for all of it. */
function CodeBlock({ code, lang, ctx }: { code: string; lang?: string; ctx: Ctx }) {
  const { s, t } = ctx;
  const lines = code.split('\n');
  const long = lines.length > FOLD_LINES;
  const [open, setOpen] = useState(false);
  const shown = long && !open ? lines.slice(0, FOLDED_LINES).join('\n') : code;
  const spans = useMemo(() => highlight(shown, lang), [shown, lang]);
  const color: Record<SynKind, string> = {
    keyword: t.colors.synKeyword, string: t.colors.synString, number: t.colors.synNumber,
    comment: t.colors.synComment, function: t.colors.synFunction, type: t.colors.synType,
  };
  return (
    <View style={s.codeBlock}>
      <View style={s.codeHead}>
        <Text style={s.codeLang}>{lang || 'code'}</Text>
        <CopyButton text={code} ctx={ctx} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text selectable={ctx.sel} style={s.codeText}>
          {spans.map((sp, i) => sp.kind ? (
            <Text key={i} style={{ color: color[sp.kind], fontStyle: sp.kind === 'comment' ? 'italic' : 'normal' }}>{sp.text}</Text>
          ) : sp.text)}
        </Text>
      </ScrollView>
      {long ? (
        <Pressable accessibilityRole="button" accessibilityLabel={open ? 'Show less code' : `Show all ${lines.length} lines`}
          onPress={() => { haptic.selection(); setOpen(!open); }} style={({ pressed }) => [s.fold, pressed && { opacity: 0.6 }]} hitSlop={6}>
          {open ? <ChevronsDownUp size={14} color={t.colors.accent} /> : <ChevronsUpDown size={14} color={t.colors.accent} />}
          <Text style={s.foldText}>{open ? 'Show less' : `Show all ${lines.length} lines`}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Copies the exact code block, then confirms with a check mark for a moment. */
function CopyButton({ text, ctx }: { text: string; ctx: Ctx }) {
  const [copied, setCopied] = useState(false);
  const { s, t } = ctx;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? 'Copied' : 'Copy code'}
      hitSlop={12}
      style={({ pressed }) => [s.copy, pressed && { opacity: 0.6 }]}
      onPress={async () => {
        haptic.light();
        await Clipboard.setStringAsync(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
    >
      {copied ? <Check size={14} color={t.colors.success} /> : <Copy size={14} color={t.colors.textSecondary} />}
      <Text style={[s.copyText, copied && { color: t.colors.success }]}>{copied ? 'Copied' : 'Copy'}</Text>
    </Pressable>
  );
}

function MdImage({ token, ctx }: { token: Tokens.Image; ctx: Ctx }) {
  const uri = ctx.resolveUrl ? ctx.resolveUrl(token.href) : token.href;
  return <Image source={{ uri }} style={ctx.s.image} contentFit="cover" accessibilityLabel={token.text || 'image'} />;
}

function openLink(href: string) {
  // Only real links: agent output is untrusted, and a javascript: URL would run inside the app.
  if (!href || !/^(https?:|mailto:)/i.test(href.trim())) return;
  if (Platform.OS === 'web') globalThis.open?.(href, '_blank', 'noopener');
  else Linking.openURL(href).catch(() => undefined);
}

function decode(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

const useStyles = makeStyles((t) => ({
  root: { gap: 6 },
  p: { ...t.type.body, color: t.colors.text },
  onAccent: { color: t.colors.onAccent },
  muted: { color: t.colors.textSecondary },
  h: { fontFamily: t.fonts.bold, color: t.colors.text, marginTop: 4, letterSpacing: -0.3 },
  bold: { fontFamily: t.fonts.semibold, color: t.colors.text },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  link: { color: t.colors.accent, textDecorationLine: 'underline' },
  linkOnAccent: { color: t.colors.onAccent },
  codeInline: { fontFamily: t.fonts.mono, fontSize: 14, backgroundColor: t.colors.codeBg, color: t.colors.codeText, borderRadius: 5, paddingHorizontal: 4 },
  codeInlineOnAccent: { backgroundColor: FIXED.onAccentWash, color: t.colors.onAccent },
  codeBlock: { backgroundColor: t.colors.codeBg, borderRadius: t.radius.md, borderWidth: 1, borderColor: t.colors.border, padding: 12, marginVertical: 2 },
  codeHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  codeLang: { ...t.type.label, fontSize: 11, color: t.colors.textSecondary },
  copy: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 2, paddingHorizontal: 4 },
  copyText: { fontFamily: t.fonts.semibold, fontSize: 12, color: t.colors.textSecondary },
  codeText: { fontFamily: t.fonts.mono, fontSize: 13.5, lineHeight: 20, color: t.colors.codeText },
  fold: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 8, paddingVertical: 4 },
  foldText: { fontFamily: t.fonts.semibold, fontSize: 12.5, color: t.colors.accent },
  quote: { flexDirection: 'row', gap: 10 },
  quoteBar: { width: 3, borderRadius: 3, backgroundColor: t.colors.accent },
  list: { gap: 4 },
  li: { flexDirection: 'row', gap: 8, paddingRight: 8 },
  bullet: { ...t.type.body, color: t.colors.textSecondary, minWidth: 14 },
  tableWrap: { borderRadius: t.radius.md, borderWidth: 1, borderColor: t.colors.border },
  tr: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: t.colors.border },
  thead: { backgroundColor: t.colors.surfaceSunken },
  td: { ...t.type.callout, color: t.colors.text, padding: 10, minWidth: 90, maxWidth: 260 },
  th: { fontFamily: t.fonts.semibold },
  hr: { height: 1, backgroundColor: t.colors.border, marginVertical: 6 },
  image: { width: 260, height: 190, borderRadius: t.radius.md, backgroundColor: t.colors.surfaceSunken },
}));
