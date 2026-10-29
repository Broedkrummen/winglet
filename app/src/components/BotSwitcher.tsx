import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { mainFirst } from '../lib/bots';
import { connectionView } from '../lib/connection';
import { usePrefs } from '../lib/prefs';
import { homeChat, useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Server } from '../lib/types';
import { useAddBot } from './AddBot';
import { AgentFace } from './AgentFace';
import { Check, ChevronsUpDown, Plus, Settings } from './icons';
import { Sheet } from './Sheet';
import { Badge, Chip, ListGroup, ListRow, Tap } from './ui';

/**
 * The "Your bots" sheet (switch, add, manage), shared by the chip and the sidebar's row of faces. `onSwitch` runs after
 * another bot is picked, for places that must also move to it (the sidebar, over an open conversation).
 */
export function useBotSheet(server: Server | undefined, onSwitch?: (serverId: string) => void) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const addBot = useAddBot();
  const sheet = server ? <>
    <Sheet visible={open} onClose={() => setOpen(false)} title="Your bots" scrollable>
      <BotList server={server} onDone={() => setOpen(false)} onSwitch={onSwitch} />
      <ListGroup style={{ marginTop: t.space.md }}>
        <ListRow icon={<Plus />} title="Add a bot" onPress={() => { setOpen(false); addBot.open(); }} />
        <ListRow icon={<Settings />} title="Manage bots" onPress={() => { setOpen(false); router.push('/bots'); }} />
      </ListGroup>
    </Sheet>
    {addBot.sheet}
  </> : null;
  return { open: () => setOpen(true), sheet };
}

function BotList({ server, onDone, onSwitch }: { server: Server; onDone: () => void; onSwitch?: (serverId: string) => void }) {
  const t = useTheme();
  const servers = useApp((st) => st.servers);
  const runtime = useApp((st) => st.runtime);
  const network = useApp((st) => st.network);
  const select = useApp((st) => st.select);
  const chosen = usePrefs((st) => st.prefs.mainBot);
  return <ListGroup>
    {mainFirst(servers, chosen).map((x, i) => {
      const rt = runtime[x.id];
      const view = connectionView(network, rt, x.bot.title);
      const on = x.id === server.id;
      return <ListRow key={x.id} title={x.bot.title} value={i === 0 ? 'Main' : undefined}
        icon={<View><AgentFace server={x} size={28} still /></View>}
        subtitle={view.kind === 'online' ? 'Online' : view.title} chevron={false}
        right={<View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
          {rt?.pending ? <Badge count={rt.pending} /> : null}
          {on ? <Check size={20} color={t.colors.accent} accessibilityLabel="Current bot" /> : null}
        </View>}
        onPress={() => { if (!on) { select(x.id, homeChat(useApp.getState().runtime[x.id])); onSwitch?.(x.id); } onDone(); }} />;
    })}
  </ListGroup>;
}

/** Switch bots, or add and manage them, from the same picker everywhere. */
export function BotSwitcher() {
  const t = useTheme();
  const servers = useApp((st) => st.servers);
  const runtime = useApp((st) => st.runtime);
  const selection = useApp((st) => st.selection);
  const server = servers.find((x) => x.id === selection.serverId) ?? servers[0];
  const picker = useBotSheet(server);
  if (!server) return null;
  const others = servers.filter((x) => x.id !== server.id).reduce((n, x) => n + (runtime[x.id]?.pending ?? 0), 0);

  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.xs, maxWidth: 240 }}>
        <Chip label={server.bot.title} icon={<AgentFace server={server} size={28} still />}
          accessibilityLabel={`${server.bot.title}. Switch bot`} onPress={picker.open} />
        {others ? <Badge count={others} dot /> : null}
      </View>
      {picker.sheet}
    </>
  );
}

/**
 * A quick row of every bot's face for the sidebar: tap one to switch to it, the last button opens the full
 * picker (add and manage). The current bot wears an accent ring; a dot means another bot is waiting on you.
 */
export function BotFaces({ server }: { server: Server }) {
  const t = useTheme();
  const s = useStyles();
  const servers = useApp((st) => st.servers);
  const pending = useApp(useShallow((st) => Object.fromEntries(st.servers.map((x) => [x.id, st.runtime[x.id]?.pending ?? 0]))));
  const chosen = usePrefs((st) => st.prefs.mainBot);
  const picker = useBotSheet(server);
  return <>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row} style={s.scroll}
      accessibilityLabel="Your bots" keyboardShouldPersistTaps="handled">
      {mainFirst(servers, chosen).map((x) => {
        const on = x.id === server.id;
        const waiting = pending[x.id] ?? 0;
        return <Tap key={x.id} feedback="selection" scaleTo={0.9} accessibilityLabel={`${x.bot.title}${waiting ? `, ${waiting} waiting` : ''}${on ? ', current bot' : '. Switch bot'}`}
          accessibilityState={{ selected: on }}
          onPress={() => { if (!on) useApp.getState().select(x.id, homeChat(useApp.getState().runtime[x.id])); }}
          style={({ hovered }) => [s.face, on ? s.faceOn : hovered && { backgroundColor: t.colors.pressed }]}>
          <AgentFace server={x} size={30} still />
          {waiting && !on ? <Badge count={waiting} dot style={s.dot} /> : null}
        </Tap>;
      })}
      <Tap feedback="selection" scaleTo={0.9} accessibilityLabel="Your bots. Add or manage bots" onPress={picker.open}
        style={({ hovered, pressed }) => [s.face, s.more, (hovered || pressed) && { backgroundColor: t.colors.pressed }]}>
        <ChevronsUpDown size={16} color={t.colors.textSecondary} />
      </Tap>
    </ScrollView>
    {picker.sheet}
  </>;
}

/**
 * The landing's bot switcher: every paired bot as a chip with its face and name, one tap away. Only shown with two or
 * more bots; the header's picker still adds and manages them.
 */
export function BotPills({ server }: { server: Server }) {
  const t = useTheme();
  const s = useStyles();
  const servers = useApp((st) => st.servers);
  const pending = useApp(useShallow((st) => Object.fromEntries(st.servers.map((x) => [x.id, st.runtime[x.id]?.pending ?? 0]))));
  const chosen = usePrefs((st) => st.prefs.mainBot);
  if (servers.length < 2) return null;
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.pillScroll} contentContainerStyle={s.pills}
    accessibilityLabel="Switch bot" keyboardShouldPersistTaps="handled">
    {mainFirst(servers, chosen).map((x) => {
      const on = x.id === server.id;
      const waiting = pending[x.id] ?? 0;
      return <Tap key={x.id} feedback="selection" scaleTo={0.96} accessibilityRole="radio" accessibilityState={{ checked: on }} aria-checked={on}
        accessibilityLabel={`${x.bot.title}${waiting ? `, ${waiting} waiting` : ''}`}
        onPress={() => { if (!on) useApp.getState().select(x.id, homeChat(useApp.getState().runtime[x.id])); }}
        style={({ pressed, hovered }) => [s.pill, on ? s.pillOn : (pressed || hovered) && { backgroundColor: t.colors.surfaceRaised }]}>
        <AgentFace server={x} size={22} still />
        <Text style={[s.pillText, on && s.pillTextOn]} numberOfLines={1}>{x.bot.title}</Text>
        {waiting && !on ? <View style={[s.pillDot, { backgroundColor: t.colors.warning }]} /> : null}
      </Tap>;
    })}
  </ScrollView>;
}

const useStyles = makeStyles((t) => ({
  pillScroll: { flexGrow: 0, alignSelf: 'stretch', marginTop: t.space.xs },
  pills: { flexGrow: 1, justifyContent: 'center', gap: 8, paddingHorizontal: t.space.lg },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 8, height: 38, paddingLeft: 8, paddingRight: 14, borderRadius: t.radius.pill,
    backgroundColor: t.colors.surface, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: t.colors.border, maxWidth: 200,
  },
  pillOn: { backgroundColor: t.colors.surfaceHigh, borderColor: t.colors.borderStrong },
  pillText: { fontFamily: t.fonts.medium, fontSize: 14.5, color: t.colors.textSecondary, flexShrink: 1 },
  pillTextOn: { color: t.colors.text, fontFamily: t.fonts.semibold },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  scroll: { flexGrow: 0, flexShrink: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 2 },
  face: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  faceOn: { borderColor: t.colors.text },
  more: { backgroundColor: t.colors.surface, borderColor: t.colors.border, borderWidth: 1 },
  dot: { position: 'absolute', top: 2, right: 2, borderWidth: 2, borderColor: t.colors.surface },
}));
