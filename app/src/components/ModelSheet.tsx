import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, Text, View, useWindowDimensions } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { sendHidden } from '../lib/actions';
import { api } from '../lib/api';
import { haptic } from '../lib/haptics';
import { modelName } from '../lib/modelOptions';
import { useModelSheet } from '../lib/modelSheet';
import { isOwner, useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { AgentInfo, Message, Server } from '../lib/types';
import { Brain, ChevronDown, ChevronLeft } from './icons';
import { PickerCard } from './PickerCard';
import { Sheet } from './Sheet';
import { Button, Tap } from './ui';

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

  // Refresh after a choice, not twice for every open/close. A late response from another chat is ignored.
  useEffect(() => {
    if (!ready || !owner) return;
    let alive = true;
    api<AgentInfo>(server, prepareChat ? '/api/agent' : `/api/agent?chat=${encodeURIComponent(chatId)}`).then((i) => alive && setSnapshot({ key, info: i })).catch(() => undefined);
    return () => { alive = false; };
  }, [server, chatId, key, ready, owner, picked, revision, prepareChat]);

  if (!ready || !owner) return null;
  const model = (!prepareChat && info?.chat?.model) || info?.configured.model || '';
  const show = () => { Keyboard.dismiss(); setMountedKey(key); setOpenKey(key); if (!info) refresh((n) => n + 1); };
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
      <ScrollView style={[s.scroll, { maxHeight: Math.min(380, windowHeight * 0.42) }]} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <View style={s.now}>
          <Text style={s.nowSub} numberOfLines={1}>{model ? modelName(model) : 'For this conversation'}{(p?.current_label || info?.chat?.provider || info?.configured.label) ? ` · ${p?.current_label || info?.chat?.provider || info?.configured.label}` : ''}</Text>
        </View>

        {showThinking ? <Tap feedback="selection" onPress={() => setAsked(false)} style={s.backModels}>
          <ChevronLeft size={16} color={t.colors.accent} /><Text style={s.backText}>Models</Text>
        </Tap> : null}
        {cardDone || confirmed ? null : showThinking && reasoning && pickerOf(reasoning) ? (
          <View style={s.thinking}>
            <PickerCard key={reasoning.id} server={server} message={reasoning} presentation="sheet" onChosen={chosen} />
          </View>
        ) : asked && !reasoningFailed ? (
          <View style={s.wait}><ActivityIndicator color={t.colors.textSecondary} /><Text style={s.nowSub}>Getting thinking options…</Text></View>
        ) : (
          <View style={s.thinking}>
            <Tap onPress={askReasoning} feedback="selection" style={s.thinkingButton}>
              <Brain size={17} color={t.colors.textSecondary} /><Text style={s.thinkingTitle}>Thinking</Text>
              <Text style={s.nowSub}>Options</Text><ChevronDown size={14} color={t.colors.textSecondary} />
            </Tap>
            {reasoningFailed ? <Text style={s.nowSub}>Thinking options aren’t available right now. Tap to retry.</Text> : null}
          </View>
        )}

        {showThinking ? null : card ? <PickerCard key={card.id} server={server} message={card} presentation="sheet" onChosen={chosen} /> : failed ? (
          <View style={s.wait}>
            <Text style={s.nowSub}>{server.bot.title} didn't send its models. It may be busy.</Text>
            <Button title="Try again" size="sm" variant="secondary" onPress={askModel} />
          </View>
        ) : (
          <View style={s.wait}><ActivityIndicator color={t.colors.textSecondary} /><Text style={s.nowSub}>Getting the models…</Text></View>
        )}

      </ScrollView>
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  button: { minHeight: 44, maxWidth: 240, paddingHorizontal: 12, borderRadius: t.radius.pill, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: t.colors.surfaceSunken },
  buttonText: { ...t.type.callout, fontFamily: t.fonts.medium, color: t.colors.text, flexShrink: 1 },
  headerButton: { backgroundColor: 'transparent', paddingHorizontal: 0, paddingRight: 8, minHeight: 28, maxWidth: '100%', alignSelf: 'flex-start' },
  headerButtonText: { ...t.type.caption, fontFamily: t.fonts.medium, color: t.colors.textSecondary },
  composerButton: { backgroundColor: 'transparent', paddingHorizontal: 8, minHeight: 40, maxWidth: '65%', flexShrink: 1 },
  composerButtonText: { ...t.type.caption, fontFamily: t.fonts.medium, color: t.colors.textSecondary },
  scroll: { flexShrink: 1 },
  body: { gap: 8, paddingHorizontal: 2, paddingBottom: 4 },
  now: { paddingHorizontal: 8 },
  nowSub: { ...t.type.caption, color: t.colors.textSecondary },
  label: { ...t.type.label, fontSize: 11, letterSpacing: 1, color: t.colors.textSecondary },
  thinking: { gap: 4 },
  thinkingButton: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 10, borderRadius: t.radius.sm, backgroundColor: t.colors.surfaceSunken },
  thinkingTitle: { ...t.type.callout, color: t.colors.text, fontFamily: t.fonts.medium, flex: 1 },
  backModels: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, alignSelf: 'flex-start', paddingRight: 12 },
  backText: { ...t.type.callout, fontFamily: t.fonts.medium, color: t.colors.accent },
  wait: { alignItems: 'center', gap: 10, paddingVertical: 14 },
}));
