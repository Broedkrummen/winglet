import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useAddBot } from '../components/AddBot';
import { AgentFace } from '../components/AgentFace';
import { Plus, Trash2 } from '../components/icons';
import { Screen } from '../components/Screen';
import { Button, Footnote, SectionHeader, Tap } from '../components/ui';
import { mainFirst } from '../lib/bots';
import { connectionView } from '../lib/connection';
import { useReducedMotion } from '../lib/motion';
import { usePrefs } from '../lib/prefs';
import { homeChat, useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';

/** Every bot this phone is paired with. Removing one unpairs this phone from it. */
export default function BotsScreen() {
  const t = useTheme();
  const s = useStyles();
  const reduced = useReducedMotion();
  const servers = useApp((st) => st.servers);
  const runtime = useApp((st) => st.runtime);
  const network = useApp((st) => st.network);
  const removeServer = useApp((st) => st.removeServer);
  const select = useApp((st) => st.select);
  const [confirm, setConfirm] = useState<string | null>(null);
  const addBot = useAddBot();
  const chosenMain = usePrefs((st) => st.prefs.mainBot);
  return (
    <Screen title="Your bots">
      <SectionHeader title={`${servers.length} paired`} />
      <View style={s.list}>
        {mainFirst(servers, chosenMain).map((srv, i) => {
          const view = connectionView(network, runtime[srv.id], srv.bot.title);
          const parent = srv.parent ? servers.find((x) => x.id === srv.parent) : undefined;
          const status = view.kind === 'online' ? 'Online' : view.title;
          const dot = view.tone === 'ok' ? t.colors.success : view.tone === 'error' ? t.colors.danger : t.colors.warning;
          return (
            <Animated.View key={srv.id} entering={reduced ? undefined : FadeIn.duration(180)}>
              <Tap feedback="selection" scaleTo={0.98} accessibilityLabel={`${srv.bot.title}${i === 0 ? ', main' : ''}, ${status}`}
                onPress={() => { select(srv.id, homeChat(useApp.getState().runtime[srv.id])); router.navigate('/agent'); }}
                style={({ pressed, hovered }) => [s.bot, (pressed || hovered) && { borderColor: t.colors.borderStrong }]}>
                <AgentFace server={srv} size={48} still />
                <View style={s.botText}>
                  <View style={s.nameRow}>
                    <Text style={s.name} numberOfLines={1}>{srv.bot.title}</Text>
                    {i === 0 ? <View style={s.main}><Text style={s.mainText}>Main</Text></View> : null}
                  </View>
                  <View style={s.statusRow}>
                    <View style={[s.dot, { backgroundColor: dot }]} />
                    <Text style={s.meta} numberOfLines={1}>{parent ? `${status} · on ${parent.bot.title}'s server` : status}</Text>
                  </View>
                </View>
                {parent ? null : (
                  // Removing mustn't also open the bot (on the web a click bubbles to the card).
                  <Pressable accessible={false} onPress={() => undefined}>
                    <Button size="sm" variant={confirm === srv.id ? 'danger' : 'ghost'} title={confirm === srv.id ? 'Remove' : ''}
                      accessibilityLabel={confirm === srv.id ? `Confirm removing ${srv.bot.title}` : `Remove ${srv.bot.title}`}
                      icon={<Trash2 size={16} color={t.colors.danger} />} style={s.remove}
                      onPress={() => { if (confirm !== srv.id) setConfirm(srv.id); else { setConfirm(null); removeServer(srv.id); } }} />
                  </Pressable>
                )}
              </Tap>
            </Animated.View>
          );
        })}
        <Button title="Add a bot" variant="secondary" icon={<Plus size={18} color={t.colors.text} />} onPress={addBot.open} style={s.add} />
      </View>
      {addBot.sheet}
      <Footnote>Removing a server unpairs all its bots from this phone. Chats stay on the server; you can pair again.</Footnote>
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  list: { gap: t.space.md },
  bot: {
    flexDirection: 'row', alignItems: 'center', gap: t.space.md, minHeight: 76, paddingVertical: t.space.md, paddingLeft: t.space.lg, paddingRight: t.space.sm,
    backgroundColor: t.colors.surface, borderRadius: t.radius.lg, borderWidth: 1, borderColor: t.colors.border,
  },
  botText: { flex: 1, minWidth: 0, gap: t.space.xs },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm },
  name: { ...t.type.heading, color: t.colors.text, flexShrink: 1 },
  main: { paddingHorizontal: t.space.sm, paddingVertical: 2, borderRadius: t.radius.xs, backgroundColor: t.colors.surfaceSunken },
  mainText: { ...t.type.caption, color: t.colors.textSecondary },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm },
  dot: { width: 7, height: 7, borderRadius: t.radius.pill },
  meta: { ...t.type.footnote, color: t.colors.textSecondary, flexShrink: 1 },
  add: { marginTop: t.space.xs },
  remove: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
}));
