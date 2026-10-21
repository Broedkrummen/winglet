import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { cancelAnimation, runOnJS, useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from 'react-native-reanimated';
import { headline } from '../lib/agent';
import { DECK_SPRING, releaseDeckPage, resistDeckEdge } from '../lib/botDeck';
import { mainFirst } from '../lib/bots';
import { haptic } from '../lib/haptics';
import { useReducedMotion } from '../lib/motion';
import { usePrefs } from '../lib/prefs';
import { homeChat, useApp, useServerState } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Server } from '../lib/types';
import { ChevronLeft, ChevronRight, MessageSquarePlus, Plus } from './icons';
import { LivePet } from './LivePet';
import { Tap } from './ui';

export type DeckPage = 'bot' | 'new-chat' | 'add-bot';
export type DockPetFrame = { centerY: number; size: number };
type DeckItem = { kind: 'bot'; id: string; title: string; server: Server } | { kind: 'new-chat' | 'add-bot'; id: string; title: string };

/** Tracking, depth and settling stay on the UI thread, including interrupted swipes. */
export const BotCarousel = memo(function BotCarousel({ selectedId, compact = false, activePage, focused = false, onPetLayout, onPageChange, onAction }: {
  selectedId: string; compact?: boolean; onPageChange?: (page: DeckPage) => void; onAction?: (page: 'new-chat' | 'add-bot') => void;
  activePage?: DeckPage; focused?: boolean; onPetLayout?: (frame: DockPetFrame) => void;
}) {
  const s = useStyles();
  const t = useTheme();
  const reduced = useReducedMotion();
  const servers = useApp((st) => st.servers);
  const chosen = usePrefs((st) => st.prefs.mainBot);
  const ordered = useMemo(() => mainFirst(servers, chosen), [servers, chosen]);
  const items = useMemo<DeckItem[]>(() => [
    { kind: 'new-chat', id: 'action:new-chat', title: 'New chat' },
    ...ordered.map((server) => ({ kind: 'bot' as const, id: server.id, title: server.bot.title, server })),
    { kind: 'add-bot', id: 'action:add-bot', title: 'Add a bot' },
  ], [ordered]);
  const [localAction, setAction] = useState<'new-chat' | 'add-bot' | null>(null);
  const action = activePage === undefined ? localAction : activePage === 'bot' ? null : activePage;
  const selected = action === 'new-chat' ? 0 : action === 'add-bot' ? items.length - 1 : Math.max(0, ordered.findIndex((x) => x.id === selectedId)) + 1;
  const [width, setWidth] = useState(0);
  const cardWidth = Math.max(1, Math.min(300, width - 128));
  const stride = Math.max(1, Math.min(230, width * 0.46));
  const page = useSharedValue(selected);
  const target = useSharedValue(selected);
  const origin = useSharedValue(selected);
  const dragging = useSharedValue(false);
  const count = items.length;

  const commit = useCallback((index: number) => {
    const item = items[index];
    if (!item) return;
    if (item.kind !== 'bot') {
      if (action === item.kind) return;
      haptic.selection();
      setAction(item.kind);
      onPageChange?.(item.kind);
      return;
    }
    const server = item.server;
    const st = useApp.getState();
    setAction(null);
    onPageChange?.('bot');
    if (st.selection.serverId === server.id) { if (action) haptic.selection(); return; }
    haptic.selection();
    st.select(server.id, homeChat(st.runtime[server.id]));
  }, [items, action, onPageChange]);

  const previousId = useRef(selectedId);
  useEffect(() => {
    if (previousId.current === selectedId) return;
    previousId.current = selectedId;
    setAction(null);
    onPageChange?.('bot');
  }, [selectedId, onPageChange]);

  const switchTo = (index: number) => {
    if (index < 0 || index >= count) return;
    cancelAnimation(page);
    target.value = index;
    page.value = reduced ? index : withSpring(index, DECK_SPRING);
    commit(index);
  };

  // Menu selection and bot removal retarget the existing deck instead of remounting pets.
  const orderKey = ordered.map((bot) => bot.id).join('\0');
  useEffect(() => {
    if (target.value === selected && !dragging.value) return;
    dragging.value = false;
    cancelAnimation(page);
    target.value = selected;
    page.value = reduced ? selected : withSpring(selected, DECK_SPRING);
  }, [selected, orderKey, reduced, page, target, dragging]);

  useEffect(() => {
    if (!dragging.value) return;
    dragging.value = false;
    page.value = reduced ? target.value : withSpring(target.value, DECK_SPRING);
  }, [stride, reduced, page, target, dragging]);

  const pan = Gesture.Pan().enabled(!focused && count > 1 && width > 0)
    .activeOffsetX([-10, 10]).failOffsetY([-14, 14])
    .onStart(() => {
      cancelAnimation(page);
      origin.value = page.value;
      dragging.value = true;
    })
    .onUpdate((e) => {
      if (!dragging.value) return;
      page.value = resistDeckEdge(origin.value - e.translationX / stride, count);
    })
    .onEnd((e, success) => {
      if (!dragging.value || !success) return;
      const next = releaseDeckPage(origin.value, e.translationX / stride, e.velocityX / stride, count);
      target.value = next;
      dragging.value = false;
      page.value = reduced ? next : withSpring(next, { ...DECK_SPRING, velocity: Math.max(-3, Math.min(3, -e.velocityX / stride)) });
      runOnJS(commit)(next);
    })
    .onFinalize(() => {
      // Cancelled touches must not leave the deck between bots.
      if (!dragging.value) return;
      dragging.value = false;
      page.value = reduced ? target.value : withSpring(target.value, DECK_SPRING);
    });

  return <View collapsable={false} pointerEvents={focused ? 'none' : 'auto'} aria-hidden={focused} accessibilityElementsHidden={focused}
    importantForAccessibility={focused ? 'no-hide-descendants' : 'auto'} onLayout={(e) => { if (e.nativeEvent.layout.width > 0) setWidth(e.nativeEvent.layout.width); }}
    style={[s.root, { display: focused ? 'none' : 'flex' }]}>
    <GestureDetector gesture={pan} touchAction="pan-y">
      <View style={[s.stage, { height: compact ? 180 : 228 }]}>
        {width ? items.map((item, index) => <DeckFrame key={item.id} index={index} page={page} nearby={Math.abs(index - selected) <= 1}
          width={cardWidth} viewport={width} stride={stride} compact={compact} reduced={reduced}>
          {item.kind === 'bot' ? <BotCard server={item.server} index={index} page={page} active={index === selected} compact={compact}
            reduced={reduced} paused={focused} onPetLayout={onPetLayout} onPress={() => switchTo(index)} /> : <ActionCard kind={item.kind} active={index === selected} compact={compact}
              onPress={() => index === selected ? onAction?.(item.kind) : switchTo(index)} />}
        </DeckFrame>) : null}
      </View>
    </GestureDetector>
    {count > 1 ? <View style={s.navigation}>
      <Tap feedback="none" disabled={selected === 0} accessibilityLabel="Previous dock page" onPress={() => switchTo(selected - 1)}
        style={[s.arrow, selected === 0 && { opacity: 0.25 }]}>
        <ChevronLeft size={18} color={t.colors.textSecondary} />
      </Tap>
      <View style={s.pages}>
        {items.map((item, index) => <PageMark key={item.id} index={index} page={page} selected={index === selected}
          label={item.kind === 'bot' ? `Switch to ${item.title}` : `Select ${item.title}`} onPress={() => switchTo(index)} />)}
      </View>
      <Tap feedback="none" disabled={selected === count - 1} accessibilityLabel="Next dock page" onPress={() => switchTo(selected + 1)}
        style={[s.arrow, selected === count - 1 && { opacity: 0.25 }]}>
        <ChevronRight size={18} color={t.colors.textSecondary} />
      </Tap>
    </View> : null}
  </View>;
});

function DeckFrame({ index, page, nearby, width, viewport, stride, compact, reduced, children }: {
  index: number; page: SharedValue<number>; nearby: boolean; width: number; viewport: number;
  stride: number; compact: boolean; reduced: boolean; children: ReactNode;
}) {
  const s = useStyles();
  const pose = useAnimatedStyle(() => {
    const distance = index - page.value;
    const depth = Math.min(1, Math.abs(distance));
    return {
      opacity: 1 - depth * 0.5,
      zIndex: 10 - Math.round(depth * 10),
      transform: [{ translateX: distance * stride }, { translateY: reduced ? 0 : depth * 12 },
        { scale: reduced ? 1 : 1 - depth * 0.16 }, { rotate: `${reduced ? 0 : Math.max(-1, Math.min(1, distance)) * 1.5}deg` }],
    };
  });
  return <Animated.View aria-hidden={!nearby} accessibilityElementsHidden={!nearby} importantForAccessibility={nearby ? 'auto' : 'no-hide-descendants'}
    style={[s.card, { left: (viewport - width) / 2, width, height: compact ? 164 : 208 }, pose]}>{children}</Animated.View>;
}

function BotCard({ server, index, page, active, compact, reduced, paused, onPress, onPetLayout }: {
  server: Server; index: number; page: SharedValue<number>; active: boolean; compact: boolean; reduced: boolean; paused?: boolean; onPress: () => void; onPetLayout?: (frame: DockPetFrame) => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const rt = useServerState(server.id);
  const label = headline(rt, server.bot.title).title;
  const [centerY, setCenterY] = useState(0);
  useEffect(() => { if (active && centerY) onPetLayout?.({ centerY, size: compact ? 74 : 98 }); }, [active, centerY, compact, onPetLayout]);
  const face = useAnimatedStyle(() => ({ transform: [{ translateX: reduced ? 0 : Math.max(-1, Math.min(1, page.value - index)) * 18 }] }));
  return (
    <Pressable onPress={active ? undefined : onPress} style={s.cardBody}
      accessible={!active} accessibilityRole={active ? undefined : 'button'} accessibilityLabel={active ? undefined : `Switch to ${server.bot.title}`}
      importantForAccessibility={active ? 'no' : 'yes'}>
      <View onLayout={(e) => setCenterY(4 + e.nativeEvent.layout.y + e.nativeEvent.layout.height / 2)} style={[s.scene, { height: compact ? 110 : 144 }]}>
        <Animated.View style={face}>
          <LivePet server={server} size={compact ? 74 : 98} bare draggable={false} active={active && !paused} />
        </Animated.View>
      </View>
      <Text style={[s.name, compact && { fontSize: 20 }]} numberOfLines={1} accessibilityRole="header">{server.bot.title}</Text>
      {label !== 'All quiet' ? <Text style={[s.status, { color: rt?.status === 'online' ? t.colors.textSecondary : t.colors.warning }]} numberOfLines={1}>{label}</Text> : null}
    </Pressable>
  );
}

function ActionCard({ kind, active, compact, onPress }: { kind: 'new-chat' | 'add-bot'; active: boolean; compact: boolean; onPress: () => void }) {
  const t = useTheme();
  const s = useStyles();
  const Icon = kind === 'new-chat' ? MessageSquarePlus : Plus;
  const title = kind === 'new-chat' ? 'New chat' : 'Add a bot';
  return <Tap feedback="none" accessibilityLabel={active ? kind === 'new-chat' ? 'Start a new chat' : 'Add a bot' : `Select ${title}`}
    onPress={onPress} style={s.cardBody}>
    <View style={[s.scene, { height: compact ? 110 : 144 }]}>
      <View style={[s.actionIcon, { backgroundColor: t.colors.accentSoft }]}><Icon size={32} color={t.colors.accent} /></View>
    </View>
    <Text style={[s.name, compact && { fontSize: 20 }]}>{title}</Text>
  </Tap>;
}

function PageMark({ index, page, selected, label, onPress }: { index: number; page: SharedValue<number>; selected: boolean; label: string; onPress: () => void }) {
  const t = useTheme();
  const s = useStyles();
  const mark = useAnimatedStyle(() => {
    const focus = 1 - Math.min(1, Math.abs(page.value - index));
    return { opacity: 0.3 + focus * 0.7, transform: [{ scaleX: 1 + focus * 1.8 }] };
  });
  return <Tap feedback="none" accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress} style={s.pageTarget}>
    <Animated.View style={[s.mark, { backgroundColor: t.colors.accent }, mark]} />
  </Tap>;
}

const useStyles = makeStyles((t) => ({
  root: { width: '100%' },
  stage: { width: '100%', overflow: 'hidden' },
  card: { position: 'absolute', top: 4 },
  cardBody: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingBottom: 8 },
  scene: { width: '100%', alignItems: 'center', justifyContent: 'center' },
  actionIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  name: { ...t.type.title, color: t.colors.text, fontSize: 23, textAlign: 'center' },
  status: { ...t.type.caption, textAlign: 'center', marginTop: 6 },
  navigation: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 },
  pages: { flexDirection: 'row', flexShrink: 1, flexWrap: 'wrap', justifyContent: 'center' },
  arrow: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  pageTarget: { minWidth: 32, height: 44, alignItems: 'center', justifyContent: 'center' },
  mark: { width: 6, height: 6, borderRadius: 3 },
}));
