import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { connectionView } from '../lib/connection';
import { homeChat, useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import { useAddBot } from './AddBot';
import { AgentFace } from './AgentFace';
import { Check, ChevronDown, Plus, Settings } from './icons';
import { Sheet, SheetAction } from './Sheet';
import { Badge, Tap } from './ui';

/** The current bot, as a pill at the top of each tab. Tap to switch bots or add one. */
export function BotSwitcher() {
  const t = useTheme();
  const s = useStyles();
  const servers = useApp((st) => st.servers);
  const runtime = useApp((st) => st.runtime);
  const network = useApp((st) => st.network);
  const selection = useApp((st) => st.selection);
  const select = useApp((st) => st.select);
  const [open, setOpen] = useState(false);
  const addBot = useAddBot();
  const server = servers.find((x) => x.id === selection.serverId) ?? servers[0];
  if (!server) return null;
  const others = servers.filter((x) => x.id !== server.id).reduce((n, x) => n + (runtime[x.id]?.pending ?? 0), 0);

  return (
    <>
      <Tap feedback="selection" accessibilityLabel={`${server.bot.title}. Switch bot`} onPress={() => setOpen(true)}
        style={({ hovered }) => [s.pill, hovered && { backgroundColor: t.colors.pressed }]}>
        <AgentFace server={server} size={28} still />
        <Text style={s.name} numberOfLines={1}>{server.bot.title}</Text>
        <ChevronDown size={16} color={t.colors.textSecondary} />
        {others ? <Badge count={others} dot style={{ marginLeft: -2 }} /> : null}
      </Tap>
      <Sheet visible={open} onClose={() => setOpen(false)} title="Your bots">
        {servers.map((x) => {
          const rt = runtime[x.id];
          const view = connectionView(network, rt, x.bot.title);
          const on = x.id === server.id;
          return (
            <Tap key={x.id} feedback="selection" accessibilityLabel={`${x.bot.title}${on ? ', current' : ''}`}
              onPress={() => { if (!on) select(x.id, homeChat(useApp.getState().runtime[x.id])); setOpen(false); }}
              style={({ pressed }) => [s.botRow, pressed && { backgroundColor: t.colors.pressed }]}>
              <AgentFace server={x} size={44} still />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.botName} numberOfLines={1}>{x.bot.title}</Text>
                <Text style={s.botSub} numberOfLines={1}>{view.kind === 'online' ? (rt?.pending ? `${rt.pending} waiting for you` : 'Online') : view.title}</Text>
              </View>
              {rt?.pending ? <Badge count={rt.pending} /> : null}
              {on ? <Check size={20} color={t.colors.accent} /> : null}
            </Tap>
          );
        })}
        <View style={s.divider} />
        <SheetAction icon={<Plus size={20} color={t.colors.success} />} label="Add a bot" onPress={() => { setOpen(false); addBot.open(); }} />
        <SheetAction icon={<Settings size={20} color={t.colors.textSecondary} />} label="Manage bots" onPress={() => { setOpen(false); router.push('/bots'); }} />
      </Sheet>
      {addBot.sheet}
    </>
  );
}

const useStyles = makeStyles((t) => ({
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 5, paddingRight: 12, minHeight: 40, borderRadius: t.radius.pill,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border, alignSelf: 'flex-start', maxWidth: 240,
  },
  name: { ...t.type.bodyStrong, fontSize: 15, color: t.colors.text, flexShrink: 1 },
  botRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 12, paddingVertical: 10, borderRadius: t.radius.md, minHeight: 64 },
  botName: { ...t.type.bodyStrong, color: t.colors.text },
  botSub: { ...t.type.callout, color: t.colors.textSecondary },
  divider: { height: 1, backgroundColor: t.colors.border, marginVertical: 8, marginHorizontal: 12 },
}));
