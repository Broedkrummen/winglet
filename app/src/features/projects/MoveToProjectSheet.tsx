import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Check, Folder, FolderPlus, Inbox, Search } from '../../components/icons';
import { Button, SearchField, Tap } from '../../components/ui';
import { projectCountLabel, projectOf, projectTitle } from './logic';
import { useApp } from '../../lib/store';
import { makeStyles, useTheme } from '../../lib/themeContext';
import type { Project, Server } from '../../lib/types';

const useStyles = makeStyles((t) => ({
  note: { ...t.type.callout, color: t.colors.textSecondary, paddingHorizontal: 8, paddingBottom: 8 },
  list: { maxHeight: 360 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 12, borderRadius: t.radius.md },
  icon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.accentSoft },
  title: { ...t.type.body, fontFamily: t.fonts.medium, color: t.colors.text },
  sub: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textSecondary, marginTop: 2 },
  empty: { alignItems: 'center', gap: 10, paddingVertical: 18, paddingHorizontal: 16 },
  emptyText: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center' },
}));

/** Choose the project a chat belongs to; "No project" leaves it in Chats only. Used inside a chat's sheet. */
export function ProjectPicker({ server, chatId, onDone }: {
  server: Server; chatId: string; onDone: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const snapshot = useApp((st) => st.runtime[server.id]?.projects);
  const runtime = useApp((st) => st.runtime[server.id]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { setQuery(''); setBusy(null); }, [chatId]);
  const current = projectOf(snapshot, chatId);
  const online = !!runtime?.info?.features?.projects && runtime.status === 'online';
  const q = query.trim().toLowerCase();
  const projects = (snapshot?.projects ?? []).filter((p) => !p.archived
    && (!q || p.name.toLowerCase().includes(q))).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const move = async (project: Project | null) => {
    if (busy) return;
    setBusy(project?.id ?? 'none');
    try {
      await useApp.getState().moveChatToProject(server.id, chatId, project?.id ?? null);
      useApp.getState().toast({ serverId: server.id, title: project ? 'Chat moved' : 'Chat removed from project',
        body: project ? `It is now in “${project.name}”.` : 'It is still in Chats, with its messages and draft.' });
      onDone();
    } catch (e) {
      useApp.getState().toast({ serverId: server.id, title: "Couldn't move the chat", body: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const row = (project: Project | null, key: string) => {
    const selected = project ? current?.id === project.id : !current;
    const label = project ? project.name : 'No project';
    const sub = project ? `${project.private ? 'Only you' : 'Shared'} · ${projectCountLabel(project)}` : 'Just in Chats';
    return (
      <Tap key={key} feedback="selection" accessibilityRole="radio" accessibilityState={{ selected, busy: busy === key }}
        accessibilityLabel={`${label}. ${sub}${selected ? '. Current project' : ''}`} disabled={!!busy}
        onPress={() => move(project)} style={({ pressed, hovered }) => [s.row, (pressed || hovered) && { backgroundColor: t.colors.pressed }]}>
        <View style={[s.icon, !project && { backgroundColor: t.colors.surfaceSunken }]}>
          {project ? <Folder size={18} color={t.colors.onAccentSoft} /> : <Inbox size={18} color={t.colors.textSecondary} />}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.title} numberOfLines={1}>{label}</Text>
          <Text style={s.sub} numberOfLines={1}>{sub}</Text>
        </View>
        {selected ? <Check size={19} color={t.colors.accent} accessibilityLabel="Current" /> : null}
      </Tap>
    );
  };
  return (
    <>
      {!online ? <Text style={s.note}>Connect to your bot to move this chat.</Text> : !snapshot ? (
        <View style={s.empty}><Text style={s.emptyText}>Projects are still loading.</Text></View>
      ) : !snapshot.projects.length ? (
        <View style={s.empty}>
          <FolderPlus size={26} color={t.colors.textTertiary} />
          <Text style={s.emptyText}>You have no projects yet. Create one to group chats by topic.</Text>
          <Button title="Open projects" variant="secondary" onPress={() => { onDone(); router.push('/projects'); }} />
        </View>
      ) : (
        <>
          <Text style={s.note}>This only changes where the chat is listed. Its messages, draft, pin and Hermes session stay as they are.</Text>
          {snapshot.projects.length > 6 ? (
            <SearchField value={query} onChangeText={setQuery} placeholder="Find a project" style={{ marginBottom: 8 }} />
          ) : null}
          <ScrollView style={s.list} keyboardShouldPersistTaps="handled">
            {row(null, 'none')}
            {projects.map((project) => row(project, project.id))}
            {!projects.length ? <View style={s.empty}>
              <Search size={20} color={t.colors.textTertiary} />
              <Text style={s.emptyText}>No project matches “{query.trim()}”.</Text>
            </View> : null}
          </ScrollView>
          <Text style={s.note}>{current ? `Currently in “${projectTitle(current)}”.` : 'This chat is not in a project.'}</Text>
        </>
      )}
    </>
  );
}
