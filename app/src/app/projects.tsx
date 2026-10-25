import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { withSelectedServer } from '../components/ServerScreen';
import { Screen } from '../components/Screen';
import { ChevronDown, ChevronRight, CircleAlert, Folder, FolderPlus, Lock, MoreHorizontal, Plus, Search } from '../components/icons';
import { Button, IconButton, SearchField, Skeleton, Tap } from '../components/ui';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { useApp } from '../lib/store';
import { useReducedMotion } from '../lib/motion';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Project } from '../lib/types';
import { ProjectCreateSheet, ProjectMenuSheet } from '../features/projects/ProjectSheets';
import { projectCountLabel } from '../features/projects/logic';

/** Every project on the selected bot: shared ones, a member's private ones, and archived ones. */
export default withSelectedServer(ProjectsScreen);

function ProjectsScreen() {
  const t = useTheme();
  const s = useStyles();
  const reduced = useReducedMotion();
  const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
  const snapshot = useApp((st) => (server ? st.runtime[server.id]?.projects : undefined));
  const runtime = useApp((st) => (server ? st.runtime[server.id] : undefined));
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const feature = !!runtime?.info?.features?.projects;
  useEffect(() => {
    if (server && feature) useApp.getState().loadProjects(server.id);
  }, [server?.id, feature]);
  if (!server) return null;
  const q = query.trim().toLowerCase();
  const match = (p: Project) => !q || p.name.toLowerCase().includes(q);
  const active = (snapshot?.projects ?? []).filter((p) => !p.archived && match(p));
  const archived = (snapshot?.projects ?? []).filter((p) => p.archived && match(p));
  const shared = active.filter((p) => !p.private);
  const mine = active.filter((p) => p.private);
  // A first load shows skeleton rows; a bot that is already offline says so instead of waiting forever.
  const waiting = !runtime || runtime.status === 'connecting';
  const row = (project: Project) => (
    <ProjectRow key={project.id} project={project}
      onOpen={() => router.push(`/project/${server.id}/${project.id}`)}
      onMenu={project.can_manage && runtime?.status === 'online' ? () => setMenu(project.id) : undefined} />
  );
  return (
    <Screen title="Projects"
      subtitle="Folders for conversations on this bot. Every chat keeps its own Hermes session."
      right={feature && runtime?.status === 'online' ? (
        <IconButton label="New project" variant="tonal" onPress={() => setCreating(true)}><Plus size={21} color={t.colors.onAccentSoft} /></IconButton>
      ) : undefined}>
      <ConnectionBanner server={server} compact />
      {!feature && runtime?.info ? (
        <View style={s.notice}>
          <CircleAlert size={20} color={t.colors.warning} />
          <Text style={s.noticeText}>This server can't store projects yet. Update Winglet on the server, then reopen this page. Your chats, pins and archives keep working.</Text>
        </View>
      ) : !snapshot && waiting ? (
        <View style={{ gap: 10, marginTop: 18 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={62} radius={16} />)}</View>
      ) : !snapshot ? (
        <View style={s.empty}>
          <CircleAlert size={26} color={t.colors.warning} />
          <Text style={s.emptyTitle}>Projects need a connection</Text>
          <Text style={s.emptyText}>Connect to your bot to load projects. Chats, pins and archives stay available offline.</Text>
          <Button title="Open Chats" variant="secondary" onPress={() => router.push('/chats')} />
        </View>
      ) : (
        <>
          <View style={{ marginTop: 16 }}>
            <SearchField value={query} onChangeText={setQuery} placeholder="Search projects" />
          </View>
          {active.length ? (
            <Animated.View entering={reduced ? undefined : FadeIn.duration(180)} style={s.group}>
              {shared.length ? <Text style={s.section} accessibilityRole="header">Shared projects</Text> : null}
              {shared.map(row)}
              {mine.length ? <Text style={s.section} accessibilityRole="header">Only you</Text> : null}
              {mine.map(row)}
            </Animated.View>
          ) : q && !archived.length ? (
            <View style={s.empty}>
              <Search size={24} color={t.colors.textTertiary} />
              <Text style={s.emptyTitle}>No project matches “{query.trim()}”</Text>
              <Button title="Clear search" variant="secondary" onPress={() => setQuery('')} />
            </View>
          ) : !q && !snapshot.projects.length ? (
            <View style={s.empty}>
              <View style={s.emptyIcon}><FolderPlus size={28} color={t.colors.onAccentSoft} /></View>
              <Text style={s.emptyTitle}>No projects yet</Text>
              <Text style={s.emptyText}>Group chats by topic or client. Projects are saved on your server, so every device that can see them agrees on the same folders and order.</Text>
              {feature && runtime?.status === 'online' ? <Button title="Create a project" icon={<Plus size={17} color={t.colors.onAccent} />} onPress={() => setCreating(true)} /> : null}
            </View>
          ) : null}
          {archived.length ? (
            <View style={{ marginTop: 16 }}>
              <Tap accessibilityRole="button" accessibilityState={{ expanded: archivedOpen }} accessibilityLabel={`Archived projects, ${archived.length}`}
                onPress={() => setArchivedOpen((v) => !v)} style={s.archiveHead}>
                {archivedOpen ? <ChevronDown size={17} color={t.colors.textSecondary} /> : <ChevronRight size={17} color={t.colors.textSecondary} />}
                <Text style={s.archiveTitle}>Archived projects</Text>
                <Text style={s.archiveCount}>{archived.length}</Text>
              </Tap>
              {archivedOpen ? <Animated.View entering={reduced ? undefined : FadeIn.duration(160)} style={s.group}>{archived.map(row)}</Animated.View> : null}
            </View>
          ) : null}
          <View style={s.footnote}>
            <Text style={s.footnoteText}>Archiving or deleting a project never archives, deletes or moves its chats. They stay in Chats with their messages and drafts.</Text>
          </View>
        </>
      )}
      <ProjectCreateSheet server={server} visible={creating} onClose={() => setCreating(false)}
        onCreated={(id) => { setCreating(false); router.push(`/project/${server.id}/${id}`); }} />
      <ProjectMenuSheet server={server} projectId={menu ?? ''} visible={!!menu} onClose={() => setMenu(null)} onDeleted={() => setMenu(null)} />
    </Screen>
  );
}

function ProjectRow({ project, onOpen, onMenu }: {
  project: Project; onOpen: () => void; onMenu?: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  return (
    <Tap feedback="selection" scaleTo={0.99} accessibilityLabel={`${project.name}, ${projectCountLabel(project)}${project.archived ? ', archived' : ''}`}
      accessibilityHint={onMenu ? 'Long-press for project options' : undefined} onPress={onOpen}
      onLongPress={onMenu} delayLongPress={350}
      style={({ pressed, hovered }) => [s.row, (pressed || hovered) && { backgroundColor: t.colors.pressed }]}>
      <View style={[s.icon, project.archived && { backgroundColor: t.colors.surfaceSunken }]}>
        <Folder size={18} color={project.archived ? t.colors.textSecondary : t.colors.onAccentSoft} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={s.titleRow}>
          <Text style={s.title} numberOfLines={1}>{project.name}</Text>
          {project.private ? <Lock size={12} color={t.colors.textTertiary} accessibilityLabel="Only you" /> : null}
        </View>
        <Text style={s.sub} numberOfLines={1}>{project.private ? 'Only you' : 'Shared'} · {projectCountLabel(project)}{project.archived ? ' · Archived' : ''}</Text>
      </View>
      {onMenu ? <IconButton label={`Options for ${project.name}`} size={36} onPress={(e) => { e.stopPropagation(); onMenu(); }}>
        <MoreHorizontal size={17} color={t.colors.textSecondary} /></IconButton> : <ChevronRight size={18} color={t.colors.textTertiary} />}
    </Tap>
  );
}

const useStyles = makeStyles((t) => ({
  notice: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginTop: 18, padding: 14, borderRadius: t.radius.md,
    backgroundColor: t.colors.warningSoft },
  noticeText: { ...t.type.callout, color: t.colors.textSecondary, flex: 1 },
  group: { marginTop: 12, backgroundColor: t.colors.surface, borderRadius: t.radius.lg, borderWidth: 1, borderColor: t.colors.border, overflow: 'hidden' },
  section: { ...t.type.label, color: t.colors.textSecondary, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingHorizontal: 14, paddingVertical: 8 },
  icon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.accentSoft },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { ...t.type.bodyStrong, color: t.colors.text, flexShrink: 1 },
  sub: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textSecondary, marginTop: 2 },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 34, paddingHorizontal: 18 },
  emptyIcon: { width: 64, height: 64, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.accentSoft },
  emptyTitle: { ...t.type.title, color: t.colors.text, textAlign: 'center' },
  emptyText: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center', maxWidth: 440 },
  archiveHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, paddingHorizontal: 4 },
  archiveTitle: { ...t.type.bodyStrong, color: t.colors.text, flex: 1 },
  archiveCount: { ...t.type.caption, color: t.colors.textTertiary },
  footnote: { marginTop: 26, paddingHorizontal: 4 },
  footnoteText: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textTertiary },
}));
