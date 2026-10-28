import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Text, View, useWindowDimensions } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { sendHidden } from '../lib/actions';
import { api } from '../lib/api';
import { haptic } from '../lib/haptics';
import { activeModel, modelName } from '../lib/modelOptions';
import { useModelSheet } from '../lib/modelSheet';
import { isOwner, useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { AgentInfo, Message, Server } from '../lib/types';
import { Brain, ChevronDown, ChevronLeft, Cpu } from './icons';
import { PickerCard } from './PickerCard';
import { Sheet } from './Sheet';
import { Button, Chip, Skeleton, Tap } from './ui';

/** How long to wait for Hermes to answer with a card before saying it can't. */
const WAIT_MS = 9000;

const pickerOf = (m?: Message) => m?.meta?.picker;

/**
 * The model and reasoning level for this chat: Hermes answers /model and
 * /reasoning with cards, and the sheet shows them instead of the chat. A choice applies to this chat only.
 */
export function ModelButton({ server, chatId, variant = 'compact', prepareChat }: { server: Server; chatId: string; variant?: 'header' | 'compact' | 'composer'; prepareChat?: () => Promise<string | null> }) {
  const t = useTheme();
  const s = useStyles();
  // Primitives only: the runtime object changes with every streamed word.
  const owner = useApp((st) => isOwner(st.runtime[server.id]));
  const ready = useApp((st) => {
    const rt = st.runtime[server.id];
    return !!rt?.info?.features?.agent && !!rt?.info?.features?.pickers && rt?.status === 'online';
  });
  const key = `${server.id}:${chatId}`;
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [mountedKey, setMountedKey] = useState<string | null>(null);
  const open = openKey === key;
  const mounted = mountedKey === key;
  const close = useCallback(() => setOpenKey((current) => current === key ? null : current), [key]);
  const [snapshot, setSnapshot] = useState<{ key: string; info: AgentInfo } | null>(null);
  const info = snapshot?.key === key ? snapshot.info : null;
  const [revision, refresh] = useState(0);
  // Re-read after a model card in this chat is answered.
  const picked = useApp((st) => {
    const list = st.runtime[server.id]?.messages[chatId] ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].meta?.picker?.kind === 'model' && list[i].meta.picker!.status === 'done') return list[i].id;
    }
    return undefined;
  });
  const lastReply = useApp((st) => st.runtime[server.id]?.lastReplyAt);

  // Re-read after choices, completed replies and explicit opens. Ignore responses from a previous chat.
  useEffect(() => {
    if (!ready || !owner) return;
    let alive = true;
    api<AgentInfo>(server, prepareChat ? '/api/agent' : `/api/agent?chat=${encodeURIComponent(chatId)}`).then((i) => alive && setSnapshot({ key, info: i })).catch(() => undefined);
    return () => { alive = false; };
  }, [server, chatId, key, ready, owner, picked, revision, prepareChat, lastReply]);

  if (!ready || !owner) return null;
  const model = activeModel(info).model;
  const show = () => { Keyboard.dismiss(); setMountedKey(key); setOpenKey(key); refresh((n) => n + 1); };
  return (
    <>
      <Tap feedback="selection" scaleTo={0.98} onPress={prepareChat ? async () => {
        Keyboard.dismiss();
        const destination = await prepareChat();
        if (destination) { const next = `${server.id}:${destination}`; setMountedKey(next); setOpenKey(next); }
      } : show}
        style={({ pressed }) => [s.button, variant === 'header' && s.headerButton, variant === 'composer' && s.composerButton, pressed && { backgroundColor: t.colors.pressed }]}
        accessibilityLabel={`${model ? `Model: ${modelName(model)}` : 'Choose a model'}. Change the model or reasoning`}
        accessibilityState={{ expanded: open }} hitSlop={variant === 'header' ? 6 : undefined}>
        <Text style={[s.buttonText, variant === 'header' && s.headerButtonText, variant === 'composer' && s.composerButtonText]} numberOfLines={1}>{model ? modelName(model) : 'Model'}</Text>
        <ChevronDown size={14} color={t.colors.textSecondary} />
      </Tap>
      {mounted ? <ModelSheet key={key} server={server} chatId={chatId} visible={open} onClose={close} onDismiss={() => setMountedKey((current) => current === key ? null : current)} model={model} info={info} onChanged={() => refresh((n) => n + 1)} /> : null}
    </>
  );
}

function ModelSheet({ server, chatId, visible, onClose, onDismiss, model, info, onChanged }: {
  server: Server; chatId: string; visible: boolean; onClose: () => void; onDismiss: () => void; model: string; info: AgentInfo | null; onChanged: () => void;
}) {
  const s = useStyles();
  const t = useTheme();
  const { height: windowHeight } = useWindowDimensions();
  const key = `${server.id}:${chatId}`;
  // The newest model card in this chat. An old, answered one is only shown if it was open when the sheet came up.
  const latest = useApp((st) => {
    const list = st.runtime[server.id]?.messages[chatId] ?? [];
    for (let i = list.length - 1; i >= 0; i--) if (pickerOf(list[i])?.kind === 'model') return list[i];
    return undefined;
  });
  const slot = useModelSheet((st) => st.slots[key]);
  const reasoning = useApp((st) => {
    if (!slot) return undefined;
    const list = st.runtime[server.id]?.messages[chatId] ?? [];
    return list.find((m) => (slot.claimed ? m.id === slot.claimed : pickerOf(m)?.kind === 'choice' && !slot.before.includes(m.id)));
  });
  const [shownId, setShownId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [asked, setAsked] = useState(false);
  const [reasoningFailed, setReasoningFailed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  // The "didn't answer" timers: one of each at a time, and none left running once the sheet is closed.
  const modelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reasoningTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stopTimers = () => { clearTimeout(modelTimer.current); clearTimeout(reasoningTimer.current); };
  useEffect(() => () => { stopTimers(); useModelSheet.getState().clear(key); }, [key]);

  const askModel = () => {
    setFailed(false);
    setShownId(null);
    sendHidden(server, chatId, '/model', 'models');
    clearTimeout(modelTimer.current);
    modelTimer.current = setTimeout(() => setFailed(true), WAIT_MS);
  };

  const p = pickerOf(latest);
  const openCard = !!latest && p?.status === 'open' && p.expires_at * 1000 > Date.now();

  // Coming up: reuse a card that's still open, else ask Hermes for a fresh one.
  useEffect(() => {
    if (!visible) {
      stopTimers();
      setShownId(null);
      setFailed(false);
      useModelSheet.getState().clear(key);
      setAsked(false);
      setReasoningFailed(false);
      setConfirmed(false);
      return;
    }
    if (openCard) setShownId(latest!.id);
    else askModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // A card that arrives after asking is the one to show.
  useEffect(() => {
    if (!visible || !openCard || shownId) return;
    clearTimeout(modelTimer.current);
    setFailed(false);
    setShownId(latest!.id);
  }, [visible, openCard, shownId, latest]);
  const card = latest && shownId === latest.id ? latest : undefined;
  const cardDone = pickerOf(card)?.status === 'done';

  // After a pick (a model or a reasoning level), a moment to see Hermes's confirmation, then back to the chat.
  const picked = confirmed || cardDone || pickerOf(reasoning)?.status === 'done';
  useEffect(() => {
    if (!visible || !picked) return;
    const id = setTimeout(onClose, 650);
    return () => clearTimeout(id);
  }, [visible, picked, onClose]);

  // The reasoning card: note the first new one as ours, so the chat never shows it.
  useEffect(() => {
    if (!reasoning) return;
    clearTimeout(reasoningTimer.current);
    if (!slot?.claimed) useModelSheet.getState().claim(key, reasoning.id);
  }, [reasoning, slot?.claimed, key]);

  const askReasoning = () => {
    if (asked && !reasoningFailed) return;
    haptic.light();
    setReasoningFailed(false);
    const before = (useApp.getState().runtime[server.id]?.messages[chatId] ?? []).filter((m) => pickerOf(m)).map((m) => m.id);
    useModelSheet.getState().ask(key, before, WAIT_MS / 1000 + 3);
    setAsked(true);
    sendHidden(server, chatId, '/reasoning', 'reasoning levels');
    clearTimeout(reasoningTimer.current);
    reasoningTimer.current = setTimeout(() => setReasoningFailed(true), WAIT_MS);
  };
  const chosen = () => { setConfirmed(true); onChanged(); };
  const showThinking = asked && !reasoningFailed;

  return (
    <Sheet visible={visible} onClose={onClose} onDismiss={onDismiss} title={showThinking ? 'Thinking' : 'Choose model'}>
      <ScrollView style={[s.scroll, { maxHeight: Math.min(560, windowHeight * 0.68) }]} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        {showThinking ? (
          <View style={s.controls}>
            <Button title="Models" size="sm" variant="ghost" icon={<ChevronLeft size={16} color={t.colors.accent} />} onPress={() => setAsked(false)} />
          </View>
        ) : (
          <View style={s.now}>
            <View style={s.nowIcon}><Cpu size={20} color={t.colors.textSecondary} /></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.nowName} numberOfLines={1}>{model ? modelName(model) : 'Choose a model'}</Text>
              <Text style={s.nowSub} numberOfLines={1}>{activeModel(info).provider || 'This chat'}</Text>
            </View>
            {!cardDone && !confirmed ? <Chip label="Thinking" icon={<Brain size={16} color={t.colors.textSecondary} />} onPress={askReasoning} /> : null}
          </View>
        )}
        {reasoningFailed ? <Text style={[s.nowSub, s.inset]}>Thinking options unavailable. Tap Thinking to retry.</Text> : null}
        {showThinking ? reasoning && pickerOf(reasoning) ? (
          <PickerCard key={reasoning.id} server={server} message={reasoning} presentation="sheet" onChosen={chosen} />
        ) : <ModelSkeleton label="Loading thinking options" /> : card ? (
          <PickerCard key={card.id} server={server} message={card} presentation="sheet" onChosen={chosen} />
        ) : failed ? (
          <View style={s.wait}>
            <Text style={s.nowSub}>Models unavailable right now.</Text>
            <Button title="Try again" size="sm" variant="secondary" onPress={askModel} />
          </View>
        ) : <ModelSkeleton label="Loading models" />}
      </ScrollView>
    </Sheet>
  );
}

function ModelSkeleton({ label }: { label: string }) {
  const s = useStyles();
  return <View accessibilityLabel={label} accessibilityState={{ busy: true }} style={s.skeleton}>
    {[0, 1, 2, 3, 4].map((index) => <View key={index} style={s.skeletonRow}>
      <Skeleton width={index % 2 ? '58%' : '72%'} height={16} />
      <Skeleton width="38%" height={12} />
    </View>)}
  </View>;
}

const useStyles = makeStyles((t) => ({
  button: { minHeight: 44, maxWidth: 240, paddingHorizontal: 12, borderRadius: t.radius.pill, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: t.colors.surfaceSunken },
  buttonText: { ...t.type.callout, fontFamily: t.fonts.medium, color: t.colors.text, flexShrink: 1 },
  headerButton: { backgroundColor: 'transparent', paddingHorizontal: 0, paddingRight: 8, minHeight: 28, maxWidth: '100%', alignSelf: 'flex-start' },
  headerButtonText: { ...t.type.caption, fontFamily: t.fonts.medium, color: t.colors.textSecondary },
  composerButton: { backgroundColor: 'transparent', paddingHorizontal: 10, minHeight: 36, maxWidth: '65%', flexShrink: 1 },
  composerButtonText: { ...t.type.footnote, fontSize: 13.5, fontFamily: t.fonts.medium, color: t.colors.textSecondary },
  scroll: { flexShrink: 1 },
  body: { gap: t.space.md, paddingHorizontal: 2, paddingBottom: t.space.xs },
  controls: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm, minHeight: 44 },
  now: {
    flexDirection: 'row', alignItems: 'center', gap: t.space.md, padding: t.space.md, borderRadius: t.radius.lg,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
  },
  nowIcon: { width: 44, height: 44, borderRadius: t.radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.surfaceSunken },
  nowName: { ...t.type.heading, color: t.colors.text },
  nowSub: { ...t.type.footnote, color: t.colors.textSecondary },
  inset: { paddingHorizontal: t.space.sm },
  skeleton: { gap: t.space.sm },
  skeletonRow: {
    minHeight: 60, justifyContent: 'center', gap: t.space.sm, paddingHorizontal: t.space.lg, borderRadius: t.radius.lg,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
  },
  wait: { alignItems: 'center', gap: t.space.md, paddingVertical: t.space.lg },
}));
