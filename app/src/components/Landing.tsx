import { router } from 'expo-router';
import { memo, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { ago, headline } from '../lib/agent';
import { chatKey } from '../lib/chatOrganization';
import { useReducedMotion } from '../lib/motion';
import { usePrefs } from '../lib/prefs';
import { homeChat, useApp, useServerState } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Server } from '../lib/types';
import type { DockPetFrame } from './ChatPet';
import { BotPills } from './BotSwitcher';
import { LivePet } from './LivePet';
import { Tap } from './ui';

export type LandingMode = 'bot' | 'new-chat';

type Suggestion = { key: string; title: string; detail: string; tone?: 'warning'; onPress: () => void };

function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 5 ? 'Up late?' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/**
 * What sits above an empty message box: the bot's pet, a greeting, and a short row of things worth doing next (what's
 * waiting, chats to pick up, a few ways to start). Switching bots and starting a new chat live in the header; everything
 * else is in the sidebar. With more than one bot, a row of chips under the greeting switches between them in one tap.
 */
export const Landing = memo(function Landing({ server, mode, focused, onPetLayout, onSuggest }: {
  server: Server; mode: LandingMode; focused: boolean; onPetLayout: (frame: DockPetFrame) => void;
  onSuggest: (text: string) => void;
}) {
  const s = useStyles();
  const t = useTheme();
  const reduced = useReducedMotion();
  const rt = useServerState(server.id);
  const pending = useApp((st) => Object.values(st.runtime).reduce((n, r) => n + (r?.pending ?? 0), 0));
  const archived = usePrefs((st) => st.prefs.archivedChats);
  // Shorter screens get a smaller pet, so the landing always fits between the header and the message box.
  const short = useWindowDimensions().height < 760;
  const PET = short ? 64 : 76;
  const [centerY, setCenterY] = useState(0);
  useEffect(() => { if (centerY) onPetLayout({ centerY, size: PET }); }, [centerY, PET, onPetLayout]);

  const bot = server.bot.title;
  const status = headline(rt, bot).title;
  const fresh = mode === 'new-chat';
  const recent = useMemo(() => {
    if (!rt || fresh) return [];
    const home = homeChat(rt);
    // Untitled chats ("New chat") say nothing about what you'd pick up, so they stay in the sidebar.
    return Object.values(rt.chats).filter((c) => c.id !== home && c.kind !== 'home' && c.title && c.title !== 'New chat'
      && !archived.includes(chatKey(server.id, c.id)))
      .sort((a, b) => b.updated_at - a.updated_at).slice(0, 2);
  }, [rt?.chats, fresh, archived, server.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const suggestions: Suggestion[] = [
    ...(pending && !fresh ? [{ key: 'inbox', title: `${pending} waiting on you`, detail: 'Open your inbox', tone: 'warning' as const,
      onPress: () => router.navigate('/inbox') }] : []),
    ...recent.map((c) => ({ key: c.id, title: c.title, detail: `Continue · ${ago(c.updated_at)}`,
      onPress: () => { useApp.getState().select(server.id, c.id); router.navigate(`/chat/${server.id}/${c.id}`); } })),
    { key: 'catch-up', title: 'Catch me up', detail: 'on what I missed', onPress: () => onSuggest('Catch me up on what I missed.') },
    { key: 'plan', title: 'Plan my day', detail: "with what's coming up", onPress: () => onSuggest('Help me plan my day.') },
    { key: 'can', title: 'What can you do?', detail: 'Tools and skills', onPress: () => onSuggest('What can you do for me?') },
  ];

  return <View style={s.root} pointerEvents={focused ? 'none' : 'box-none'}>
    <View style={s.hero} pointerEvents="box-none">
      <View style={{ width: PET, height: PET, opacity: focused ? 0 : 1 }}
        onLayout={(e) => setCenterY(e.nativeEvent.layout.y + e.nativeEvent.layout.height / 2)}>
        {/* The message box's pet takes over (and moves down to it) while you type, so this one steps aside. */}
        <LivePet server={server} size={PET} bare draggable={false} active={!focused} />
      </View>
      <Animated.View entering={reduced ? undefined : FadeIn.duration(240)} style={s.words}>
        <Text style={s.hello} accessibilityRole="header">{fresh ? 'New chat' : greeting()}</Text>
        <Text style={s.sub} numberOfLines={2}>
          {fresh ? `Start fresh with ${bot}` : status === 'All quiet' ? `How can ${bot} help?` : status}
        </Text>
      </Animated.View>
      {fresh ? null : <BotPills server={server} />}
    </View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.rail} contentContainerStyle={s.railContent}
      keyboardShouldPersistTaps="handled" accessibilityLabel="Suggestions">
      {suggestions.map((x) => <Tap key={x.key} feedback="selection" scaleTo={0.98} onPress={x.onPress} accessibilityLabel={`${x.title}, ${x.detail}`}
        style={({ pressed, hovered }) => [s.card, (pressed || hovered) && { backgroundColor: t.colors.surfaceRaised }]}>
        <View style={s.cardHead}>
          {x.tone === 'warning' ? <View style={[s.dot, { backgroundColor: t.colors.warning }]} /> : null}
          <Text style={s.cardTitle} numberOfLines={1}>{x.title}</Text>
        </View>
        <Text style={s.cardDetail} numberOfLines={1}>{x.detail}</Text>
      </Tap>)}
    </ScrollView>
  </View>;
});

const useStyles = makeStyles((t) => ({
  root: { flex: 1, width: '100%' },
  hero: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: t.space.xl, gap: t.space.lg },
  words: { alignItems: 'center', gap: 4 },
  hello: { ...t.type.hero, color: t.colors.text, textAlign: 'center' },
  sub: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center', maxWidth: 320 },
  rail: { flexGrow: 0 },
  railContent: { paddingHorizontal: 12, gap: 8, paddingBottom: 4 },
  card: {
    width: 176, paddingHorizontal: 14, paddingVertical: 11, gap: 2, borderRadius: t.radius.lg, backgroundColor: t.colors.surface,
    borderWidth: StyleSheet.hairlineWidth * 2, borderColor: t.colors.border,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  cardTitle: { fontFamily: t.fonts.semibold, fontSize: 14.5, lineHeight: 20, color: t.colors.text, flexShrink: 1 },
  cardDetail: { ...t.type.footnote, color: t.colors.textSecondary },
}));
