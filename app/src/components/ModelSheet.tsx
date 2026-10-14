import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { sendHidden } from '../lib/actions';
import { api } from '../lib/api';
import { haptic } from '../lib/haptics';
import { useModelSheet } from '../lib/modelSheet';
import { isOwner, useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { AgentInfo, Message, Server } from '../lib/types';
import { Brain, Cpu } from './icons';
import { PickerCard, shortModel } from './PickerCard';
import { Sheet } from './Sheet';
import { Button, ListGroup, ListRow, Tap } from './ui';

/** How long to wait for Hermes to answer with a card before saying it can't. */
const WAIT_MS = 9000;

const pickerOf = (m?: Message) => m?.meta?.picker;

/**
 * The model and reasoning level for this chat, in a popup beside the message box: Hermes answers /model and
 * /reasoning with cards, and the sheet shows them instead of the chat. A choice applies to this chat only.
 */
export function ModelButton({ server, chatId }: { server: Server; chatId: string }) {
  const t = useTheme();
  const s = useStyles();
  const rt = useApp((st) => st.runtime[server.id]);
  const owner = isOwner(rt);
  const ready = !!rt?.info?.features?.agent && !!rt?.info?.features?.pickers && rt?.status === 'online';
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<AgentInfo | null>(null);
  // Re-read after a model card in this chat is answered.
  const picks = useApp((st) => (st.runtime[server.id]?.messages[chatId] ?? [])
    .filter((m) => m.meta?.picker?.kind === 'model' && m.meta.picker.status === 'done').length);

  useEffect(() => {
    if (!ready || !owner) return;
    let alive = true;
    api<AgentInfo>(server, `/api/agent?chat=${encodeURIComponent(chatId)}`).then((i) => alive && setInfo(i)).catch(() => undefined);
    return () => { alive = false; };
  }, [server, chatId, ready, owner, picks]);

  if (!ready || !owner || !info?.configured.model) return null;
  const model = info.chat?.model || info.configured.model;
  const differs = info.chat?.source === 'chat';
  return (
    <>
      <Tap feedback="selection" scaleTo={0.9} onPress={() => setOpen(true)} style={[s.button, differs && { backgroundColor: t.colors.accentSoft }]}
        accessibilityLabel={`Model: ${model}${differs ? ', chosen for this chat' : ''}. Change the model or reasoning`}>
        <Cpu size={20} color={differs ? t.colors.onAccentSoft : t.colors.text} />
      </Tap>
      <ModelSheet server={server} chatId={chatId} visible={open} onClose={() => setOpen(false)} model={model} info={info} />
    </>
  );
}

function ModelSheet({ server, chatId, visible, onClose, model, info }: {
  server: Server; chatId: string; visible: boolean; onClose: () => void; model: string; info: AgentInfo;
}) {
  const s = useStyles();
  const t = useTheme();
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
  const shown = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [asked, setAsked] = useState(false);
  const [reasoningFailed, setReasoningFailed] = useState(false);

  const askModel = () => {
    setFailed(false);
    shown.current = null;
    sendHidden(server, chatId, '/model', 'models');
    setTimeout(() => setFailed(true), WAIT_MS);
  };

  // Coming up: reuse a card that's still open, else ask Hermes for a fresh one.
  useEffect(() => {
    if (!visible) {
      shown.current = null;
      useModelSheet.getState().clear(key);
      setAsked(false);
      setReasoningFailed(false);
      return;
    }
    const p = pickerOf(latest);
    if (p?.status === 'open' && p.expires_at * 1000 > Date.now()) shown.current = latest!.id;
    else askModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // A card that arrives after asking is the one to show.
  const p = pickerOf(latest);
  if (visible && latest && p?.status === 'open' && p.expires_at * 1000 > Date.now() && !shown.current) shown.current = latest.id;
  const card = latest && shown.current === latest.id ? latest : undefined;
  const cardDone = pickerOf(card)?.status === 'done';

  // After a pick, a moment to see Hermes's confirmation, then back to the chat.
  useEffect(() => {
    if (!visible || !cardDone) return;
    const id = setTimeout(onClose, 1400);
    return () => clearTimeout(id);
  }, [visible, cardDone, onClose]);

  // The reasoning card: note the first new one as ours, so the chat never shows it.
  useEffect(() => {
    if (reasoning && !slot?.claimed) useModelSheet.getState().claim(key, reasoning.id);
  }, [reasoning, slot?.claimed, key]);

  const askReasoning = () => {
    haptic.light();
    setReasoningFailed(false);
    const before = (useApp.getState().runtime[server.id]?.messages[chatId] ?? []).filter((m) => pickerOf(m)).map((m) => m.id);
    useModelSheet.getState().ask(key, before, WAIT_MS / 1000 + 3);
    setAsked(true);
    sendHidden(server, chatId, '/reasoning', 'reasoning levels');
    setTimeout(() => setReasoningFailed(true), WAIT_MS);
  };
  const effort = info.configured.reasoning_effort;

  return (
    <Sheet visible={visible} onClose={onClose} title="Model for this chat">
      <ScrollView style={{ maxHeight: 540 }} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <View style={s.now}>
          <Text style={s.nowModel} numberOfLines={1}>{shortModel(model)}</Text>
          <Text style={s.nowSub}>{info.chat?.source === 'chat' ? 'Chosen for this chat' : 'The default for new chats'}{info.configured.label ? ` · ${info.configured.label}` : ''}</Text>
        </View>

        {card ? <PickerCard server={server} message={card} /> : failed ? (
          <View style={s.wait}>
            <Text style={s.nowSub}>{server.bot.title} didn't send its models. It may be busy.</Text>
            <Button title="Try again" size="sm" variant="secondary" onPress={askModel} />
          </View>
        ) : (
          <View style={s.wait}><ActivityIndicator color={t.colors.textSecondary} /><Text style={s.nowSub}>Getting the models…</Text></View>
        )}

        {cardDone ? null : reasoning && pickerOf(reasoning) ? (
          <View style={{ gap: 8 }}>
            <Text style={s.label}>Reasoning</Text>
            <PickerCard server={server} message={reasoning} />
          </View>
        ) : asked && !reasoningFailed ? (
          <View style={s.wait}><ActivityIndicator color={t.colors.textSecondary} /><Text style={s.nowSub}>Getting the reasoning levels…</Text></View>
        ) : (
          <>
            <ListGroup>
              <ListRow icon={<Brain size={18} color={t.colors.onAccentSoft} />} title="Reasoning" subtitle="How hard it thinks before answering"
                value={effort || undefined} onPress={askReasoning} />
            </ListGroup>
            {reasoningFailed ? <Text style={s.nowSub}>This model or server doesn't offer reasoning levels right now.</Text> : null}
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  button: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.surfaceSunken },
  body: { gap: 14, paddingHorizontal: 4, paddingBottom: 8 },
  now: { gap: 2, paddingHorizontal: 8 },
  nowModel: { ...t.type.title, color: t.colors.text },
  nowSub: { ...t.type.caption, color: t.colors.textSecondary },
  label: { ...t.type.label, fontSize: 11.5, color: t.colors.textSecondary, paddingHorizontal: 8 },
  wait: { alignItems: 'center', gap: 10, paddingVertical: 14 },
}));
