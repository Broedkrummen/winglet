import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { signedApi, ApiError } from '../lib/api';
import { haptic } from '../lib/haptics';
import { availableSavedModels, isCurrentModel, modelName, modelProviders, recentModels, savedModelKey, shortModel, toggleSavedModel, type SavedModel } from '../lib/modelOptions';
import { spring, useReducedMotion } from '../lib/motion';
import { usePrefs } from '../lib/prefs';
import { isOwner, useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Message, Picker, Server } from '../lib/types';
import { Check, ChevronDown, Clock, Cpu, Search, ShieldQuestion, SlidersHorizontal, Star, X } from './icons';
import { Markdown } from './Markdown';
import { Button, Chip, Field } from './ui';

const SHOWN_PER_PROVIDER = 8;

/** The short name of a model id: "anthropic/claude-sonnet-4" → "claude-sonnet-4", and Bedrock's
 * "us.anthropic.claude-sonnet-4" → "claude-sonnet-4". */
export { shortModel } from '../lib/modelOptions';

/**
 * Hermes asks a question with fixed answers (/model, /reasoning, /fast, a command to confirm): tap
 * one and Hermes applies it. The card then shows what was chosen and Hermes's reply.
 */
export function PickerCard({ server, message, presentation = 'card', onChosen }: {
  server: Server; message: Message; presentation?: 'card' | 'sheet'; onChosen?: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const reduced = useReducedMotion();
  const [answer, setAnswer] = useState<Message | null>(null);
  const shown = answer?.id === message.id && answer.updated_at >= message.updated_at ? answer : message;
  const picker = shown.meta.picker as Picker;
  const sheet = presentation === 'sheet';
  const owner = useApp((st) => isOwner(st.runtime[server.id]));
  const favorites = usePrefs((st) => st.prefs.favoriteModels);
  const recent = usePrefs((st) => st.prefs.recentModels);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState(false);
  const [customProvider, setCustomProvider] = useState('');
  const [customModel, setCustomModel] = useState('');
  const pending = useRef(false);
  const [, tick] = useState(0);
  useEffect(() => {
    if (picker.status !== 'open') return;
    const id = setTimeout(() => tick((n) => n + 1), Math.max(0, picker.expires_at * 1000 - Date.now()) + 20);
    return () => clearTimeout(id);
  }, [picker.status, picker.expires_at]);
  const open = picker.status === 'open' && picker.expires_at * 1000 > Date.now();

  const choose = async (key: string, body: Record<string, string>) => {
    if (pending.current || picker.status !== 'open' || picker.expires_at * 1000 <= Date.now() || !owner) return;
    pending.current = true;
    let accepted = false;
    setBusy(key);
    haptic.selection();
    try {
      const result = await signedApi<{ message: Message }>(server, 'POST', `/api/pickers/${picker.id}/select`, { ...body, message_id: message.id });
      if (result.message) setAnswer(result.message);
      if (picker.kind === 'model' && body.provider && body.model) {
        const prefs = usePrefs.getState();
        prefs.update({ recentModels: recentModels(prefs.prefs.recentModels, { provider: body.provider, model: body.model }) });
      }
      accepted = true;
      haptic.success();
      onChosen?.();
    } catch (e) {
      haptic.error();
      const expired = e instanceof ApiError && e.status === 410;
      useApp.getState().toast({ serverId: server.id, title: expired ? 'Too late' : "Couldn't choose",
        body: expired ? 'That choice expired. Run the command again.' : (e as Error).message });
    } finally {
      pending.current = accepted; // a successful card can only be answered once, even before React commits
      setBusy(null);
    }
  };

  const icon = picker.kind === 'model' ? <Cpu size={18} color={t.colors.textSecondary} />
    : picker.kind === 'confirm' ? <ShieldQuestion size={18} color={t.colors.warning} /> : <SlidersHorizontal size={18} color={t.colors.textSecondary} />;

  /** A choice's state on the right of its row: a spinner while sending, a filled accent dot when it's the current one. */
  const mark = (current: boolean, sending: boolean) => sending ? <ActivityIndicator size="small" color={t.colors.accent} />
    : <View style={[s.radio, current && s.radioOn]}>{current ? <Check size={13} strokeWidth={3} color={t.colors.onAccent} /> : null}</View>;

  const q = query.trim().toLowerCase();
  const providers = useMemo(() => modelProviders(picker, q), [picker.providers, picker.current_model, picker.current_provider, q]);
  const total = (picker.providers ?? []).reduce((n, p) => n + p.models.length, 0);
  const favoriteKeys = new Set(favorites.map(savedModelKey));
  const star = (provider: string, model: string) => {
    const value = { provider, model };
    const selected = favoriteKeys.has(savedModelKey(value));
    return <Pressable accessibilityRole="button" accessibilityLabel={`${selected ? 'Unstar' : 'Star'} ${model} from ${provider}`}
      accessibilityState={{ selected }} hitSlop={2} onPress={(event) => {
        event.stopPropagation();
        const state = usePrefs.getState();
        state.update({ favoriteModels: toggleSavedModel(state.prefs.favoriteModels, value) });
        haptic.selection();
      }} style={s.star}>
      <Star size={17} color={selected ? t.colors.accent : t.colors.textTertiary} fill={selected ? t.colors.accent : 'none'} />
    </Pressable>;
  };
  // Saved sections are shortcuts, not duplicates of the same selectable model below.
  const quickKeys = new Set(sheet && !q
    ? availableSavedModels([...favorites, ...recent], picker).map(savedModelKey) : []);
  const displayedProviders = providers.map((provider) => ({ ...provider,
    models: provider.models.filter((model) => !quickKeys.has(savedModelKey({ provider: provider.slug, model }))),
  })).filter((provider) => provider.models.length > 0);
  const savedSection = (title: string, saved: SavedModel[]) => {
    const entries = availableSavedModels(saved, picker);
    if (!sheet || q || !entries.length) return null;
    return <View style={s.section}>
      <Text style={s.provider}>{title}</Text>
      {entries.map((entry) => {
        const key = `${entry.provider}/${entry.model}`;
        const current = isCurrentModel(picker, entry.provider, entry.model);
        return <View key={savedModelKey(entry)} style={[s.savedRow, current && s.currentRow]}>
          <Pressable accessibilityRole="radio" accessibilityState={{ checked: current, disabled: !!busy }} aria-checked={current} disabled={!!busy}
            accessibilityLabel={`${modelName(entry.model)}, ${entry.model}, ${entry.providerName}${current ? ', current model' : ''}`}
            onPress={() => choose(key, { provider: entry.provider, model: entry.model })} style={[s.modelRow, { flex: 1, minWidth: 0 }]}>
            <View style={s.modelText}><Text style={s.modelName} numberOfLines={1}>{modelName(entry.model)}</Text>
              <Text style={s.modelId} numberOfLines={1}>{entry.providerName} · {entry.model}</Text></View>
            {mark(current, busy === key)}
          </Pressable>
          {star(entry.provider, entry.model)}
        </View>;
      })}
    </View>;
  };

  return (
    <Animated.View entering={reduced ? undefined : FadeIn.duration(180)} style={[s.card, sheet && s.sheetCard, open && picker.kind === 'confirm' && { borderColor: t.colors.warning }]}>
      {sheet ? null : <View style={s.head}>
        <View style={[s.icon, { backgroundColor: picker.kind === 'confirm' ? t.colors.warningSoft : t.colors.surfaceSunken }]}>{icon}</View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.title}>{picker.kind === 'model' ? 'Model for this chat' : picker.kind === 'confirm' ? 'Confirm' : 'Choose a setting'}</Text>
          {picker.kind === 'model' && picker.current_model ? (
            <Text style={s.sub}>Now: {shortModel(picker.current_model)}{picker.current_label ? ` · ${picker.current_label}` : ''}</Text>
          ) : null}
        </View>
      </View>}
      {/* Hermes's own wording (it uses Markdown) for settings and confirmations, while they're open. */}
      {open && picker.kind !== 'model' && (!sheet || picker.kind === 'confirm' || details) ? <Markdown text={shown.text} /> : null}

      {picker.status === 'done' ? (
        <View style={{ gap: 8 }}>
          <View style={s.chosen}>
            <Check size={14} color={t.colors.success} />
            <Text style={s.chosenText}>{picker.selected}{picker.by ? ` · ${picker.by}` : ''}</Text>
          </View>
          <Markdown text={shown.text} />
        </View>
      ) : !open ? (
        <View style={s.chosen}>
          <Clock size={14} color={t.colors.textSecondary} />
          <Text style={[s.chosenText, { color: t.colors.textSecondary }]}>This choice expired. {sheet ? 'Close and reopen to refresh the options.' : 'Run the command again for a new one.'}</Text>
        </View>
      ) : !owner ? (
        <Text style={s.sub}>Only an owner can choose here.</Text>
      ) : picker.kind === 'model' ? (
        <View style={{ gap: sheet ? 16 : 12 }}>
          {total > (sheet ? 6 : 12) ? (
            <View style={s.search}>
              <Search size={16} color={t.colors.textTertiary} />
              <TextInput value={query} onChangeText={setQuery} placeholder="Find a model" placeholderTextColor={t.colors.textTertiary}
                style={s.searchInput} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Find a model" returnKeyType="search" />
              {query ? <Pressable onPress={() => setQuery('')} accessibilityRole="button" accessibilityLabel="Clear model search" hitSlop={8} style={s.clear}><X size={16} color={t.colors.textSecondary} /></Pressable> : null}
            </View>
          ) : null}
          {savedSection('Starred', favorites)}
          {savedSection('Recent', recent.filter((entry) => !favoriteKeys.has(savedModelKey(entry))))}
          {displayedProviders.map((p) => {
            const all = expanded[p.slug] || !!q;
            const limit = sheet ? 4 : SHOWN_PER_PROVIDER;
            const models = all ? p.models : p.models.slice(0, limit);
            const names = new Map<string, number>();
            for (const id of p.models) { const name = modelName(id); names.set(name, (names.get(name) ?? 0) + 1); }
            return (
              <View key={p.slug} style={sheet ? s.section : { gap: 8 }}>
                <Text style={s.provider}>{p.name}</Text>
                <View style={sheet ? s.modelRows : s.chips} accessibilityRole={sheet ? 'radiogroup' : undefined}>
                  {models.map((m) => {
                    const current = isCurrentModel(picker, p.slug, m);
                    const key = `${p.slug}/${m}`;
                    const name = modelName(m);
                    const showId = !!q || (names.get(name) ?? 0) > 1;
                    return (
                      sheet ? <View key={key} style={[s.savedRow, current && s.currentRow]}><Pressable accessibilityRole="radio" accessibilityState={{ checked: current, disabled: !!busy, busy: busy === key }} aria-checked={current}
                        accessibilityLabel={`${name}, ${m}, ${p.name}${current ? ', current model' : ''}`} disabled={!!busy}
                        onPress={() => choose(key, { provider: p.slug, model: m })}
                        style={({ pressed }) => [s.modelRow, { flex: 1, minWidth: 0 }, pressed && { backgroundColor: t.colors.pressed }, !!busy && busy !== key && { opacity: 0.5 }]}>
                        <View style={s.modelText}>
                          <Text style={s.modelName}>{name}</Text>
                          {showId ? <Text style={s.modelId} numberOfLines={1}>{m}</Text> : null}
                        </View>
                        {mark(current, busy === key)}
                      </Pressable>{star(p.slug, m)}</View> : <Chip key={key} label={shortModel(m)} selected={current} accessibilityLabel={`${m} from ${p.name}${current ? ', current' : ''}`}
                        icon={busy === key ? <ActivityIndicator size="small" color={t.colors.accent} /> : current ? <Check size={14} color={t.colors.textSecondary} /> : undefined}
                        onPress={() => !busy && choose(key, { provider: p.slug, model: m })} />
                    );
                  })}
                  {!all && p.models.length > limit ? (
                    sheet ? <Pressable accessibilityRole="button" accessibilityLabel={`Show all ${p.models.length} models from ${p.name}`} onPress={() => setExpanded((e) => ({ ...e, [p.slug]: true }))} style={s.more}>
                      <Text style={s.moreText}>Show {p.models.length - limit} more models</Text><ChevronDown size={16} color={t.colors.accent} />
                    </Pressable> : <Chip label={`+${p.models.length - limit} more`} onPress={() => setExpanded((e) => ({ ...e, [p.slug]: true }))} />
                  ) : null}
                </View>
              </View>
            );
          })}
          {!providers.length ? <Text style={s.sub}>No model matches “{query}”.</Text> : null}
          {picker.providers?.some((p) => p.custom_models) ? <View style={{ gap: 10 }}>
            <Text style={s.provider}>Custom model</Text>
            <View style={s.chips}>
              {picker.providers.filter((p) => p.custom_models).map((p) => <Chip key={p.slug} label={p.name}
                selected={(customProvider || picker.current_provider || picker.providers?.find((x) => x.custom_models)?.slug) === p.slug}
                onPress={() => setCustomProvider(p.slug)} />)}
            </View>
            <Field value={customModel} onChangeText={setCustomModel} placeholder="Exact model ID, e.g. vendor/model-name"
              accessibilityLabel="Custom model ID" autoCapitalize="none" autoCorrect={false} />
            <Button title="Use custom model" variant="tonal" loading={busy === 'custom'} disabled={!!busy || !customModel.trim()}
              onPress={() => choose('custom', { provider: customProvider || picker.providers?.find((p) => p.custom_models && p.slug === picker.current_provider)?.slug || picker.providers?.find((p) => p.custom_models)?.slug || '', model: customModel.trim() })} />
          </View> : null}
        </View>
      ) : picker.kind === 'confirm' ? (
        <View style={{ gap: 12 }}>
          {picker.detail ? <Markdown text={picker.detail} /> : null}
          <View style={s.buttons}>
            {(picker.choices ?? []).map((c) => (
              <Button key={c.value} size="sm" title={c.label} loading={busy === c.value} disabled={!!busy && busy !== c.value}
                variant={c.value === 'once' ? 'primary' : c.value === 'cancel' ? 'ghost' : 'secondary'} onPress={() => choose(c.value, { value: c.value })} />
            ))}
          </View>
        </View>
      ) : (
        <View style={sheet ? s.modelRows : s.chips}>
          {(picker.choices ?? []).map((c) => (
            sheet ? <Pressable key={c.value} accessibilityRole="button" accessibilityState={{ selected: !!c.current, disabled: !!busy, busy: busy === c.value }}
              disabled={!!busy} accessibilityLabel={`${c.label}${c.current ? ', current' : ''}`} onPress={() => choose(c.value, { value: c.value })}
              style={({ pressed }) => [s.settingRow, c.current && s.currentRow, pressed && { backgroundColor: t.colors.pressed }]}>
              <Text style={[s.modelName, { flex: 1 }]}>{c.label}</Text>
              {mark(!!c.current, busy === c.value)}
            </Pressable> : <Chip key={c.value} label={c.label} selected={c.current}
              icon={busy === c.value ? <ActivityIndicator size="small" color={t.colors.accent} /> : c.current ? <Check size={14} color={t.colors.textSecondary} /> : undefined}
              onPress={() => !busy && choose(c.value, { value: c.value })} />
          ))}
          {sheet ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: details }} onPress={() => setDetails((value) => !value)} style={s.more}>
            <Text style={s.moreText}>{details ? 'Hide server details' : 'Details from your agent'}</Text><ChevronDown size={16} color={t.colors.accent} />
          </Pressable> : null}
        </View>
      )}
    </Animated.View>
  );
}

const useStyles = makeStyles((t) => ({
  sheetCard: { padding: 0, borderWidth: 0, backgroundColor: 'transparent', maxWidth: undefined, marginTop: 0 },
  section: { gap: t.space.sm },
  modelRows: { gap: t.space.sm },
  // In the sheet every choice is its own frosted card; the current one is lit in the accent.
  savedRow: {
    flexDirection: 'row', alignItems: 'center', borderRadius: t.radius.lg, overflow: 'hidden',
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
  },
  currentRow: { backgroundColor: t.colors.surfaceHigh, borderColor: t.colors.text },
  star: { minHeight: 56, width: 48, alignItems: 'center', justifyContent: 'center' },
  settingRow: {
    flexDirection: 'row', alignItems: 'center', gap: t.space.md, paddingHorizontal: t.space.lg, paddingVertical: t.space.sm, minHeight: 56,
    borderRadius: t.radius.lg, backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
  },
  modelRow: { flexDirection: 'row', alignItems: 'center', gap: t.space.md, paddingLeft: t.space.lg, paddingRight: t.space.xs, paddingVertical: t.space.sm, minHeight: 56 },
  radio: {
    width: 22, height: 22, borderRadius: t.radius.pill, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: t.colors.borderStrong,
  },
  radioOn: { backgroundColor: t.colors.accentFill, borderColor: t.colors.accentFill },
  modelText: { flex: 1, minWidth: 0, gap: 1 },
  modelName: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.text },
  modelId: { ...t.type.caption, color: t.colors.textSecondary },
  more: {
    minHeight: 44, paddingHorizontal: t.space.lg, flexDirection: 'row', gap: 6, alignItems: 'center', alignSelf: 'flex-start',
    borderRadius: t.radius.md, backgroundColor: t.colors.surfaceSunken,
  },
  moreText: { ...t.type.callout, fontFamily: t.fonts.medium, color: t.colors.text },
  clear: { width: 32, height: 44, alignItems: 'center', justifyContent: 'center' },
  card: {
    gap: 12, padding: t.space.lg, borderRadius: t.radius.lg, backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
    marginTop: 4, maxWidth: 560,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 40, height: 40, borderRadius: t.radius.pill, alignItems: 'center', justifyContent: 'center' },
  title: { ...t.type.bodyStrong, color: t.colors.text },
  sub: { ...t.type.caption, color: t.colors.textSecondary, marginTop: 2 },
  provider: { ...t.type.caption, fontFamily: t.fonts.semibold, letterSpacing: 0.6, textTransform: 'uppercase', color: t.colors.textTertiary, paddingHorizontal: t.space.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chosen: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chosenText: { ...t.type.caption, fontFamily: t.fonts.semibold, color: t.colors.success },
  search: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: t.space.lg, height: 44, borderRadius: t.radius.pill,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
  },
  searchInput: { flex: 1, ...t.type.callout, color: t.colors.text, ...({ outlineStyle: 'none' } as object) },
}));
