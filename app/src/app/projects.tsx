import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { withSelectedServer } from '../components/ServerScreen';
import { Screen } from '../components/Screen';
import { ChevronDown, ChevronRight, CircleAlert, Folder, MoreHorizontal, Plus, Search } from '../components/icons';
import { Button, Footnote, IconButton, ListGroup, ListRow, SearchField, SectionHeader, Skeleton, Tap } from '../components/ui';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { useApp } from '../lib/store';
import { spring, useReducedMotion } from '../lib/motion';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Project } from '../lib/types';
import { ProjectCreateSheet, ProjectMenuSheet } from '../features/projects/ProjectSheets';
import { projectCountLabel } from '../features/projects/logic';

const rise = (reduced: boolean, i: number) => (reduced ? undefined
  : FadeIn.duration(180));

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
      right={feature && runtime?.status === 'online' ? (
        <IconButton label="New project" onPress={() => setCreating(true)}><Plus size={22} color={t.colors.text} /></IconButton>
      ) : undefined}>
      <ConnectionBanner server={server} compact />
      {!feature && runtime?.info ? (
        <View style={s.notice}>
          <CircleAlert size={20} color={t.colors.warning} />
          <Text style={s.noticeText}>Update Winglet on the server to use projects.</Text>
        </View>
      ) : !snapshot && waiting ? (
        <View style={{ gap: 10, marginTop: 18 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={62} radius={t.radius.lg} />)}</View>
      ) : !snapshot ? (
        <View style={s.empty}>
          <CircleAlert size={26} color={t.colors.warning} />
          <Text style={s.emptyText}>Connect to your bot to load projects.</Text>
          <Button title="Open chats" variant="secondary" onPress={() => router.push('/chats')} />
        </View>
      ) : (
        <>
          <View style={{ marginTop: 16 }}>
            <SearchField value={query} onChangeText={setQuery} placeholder="Search projects" />
          </View>
          {active.length ? (
            <View>
              {shared.length ? <Animated.View entering={rise(reduced, 0)}><SectionHeader title="Shared projects" /><ListGroup>{shared.map(row)}</ListGroup></Animated.View> : null}
              {mine.length ? <Animated.View entering={rise(reduced, 1)}><SectionHeader title="Only you" /><ListGroup>{mine.map(row)}</ListGroup></Animated.View> : null}
            </View>
          ) : q && !archived.length ? (
            <View style={s.empty}>
              <Search size={24} color={t.colors.textTertiary} />
              <Text style={s.emptyTitle}>No project matches “{query.trim()}”</Text>
              <Button title="Clear search" variant="secondary" onPress={() => setQuery('')} />
            </View>
          ) : !q && !snapshot.projects.length ? (
            <Animated.View entering={rise(reduced, 0)} style={s.empty}>
              <View style={s.emptyIcon}><Folder size={28} color={t.colors.textSecondary} /></View>
              <Text style={s.emptyText}>No projects yet.</Text>
              {feature && runtime?.status === 'online' ? <Button title="Create a project" icon={<Plus size={17} color={t.colors.onAccent} />} onPress={() => setCreating(true)} /> : null}
            </Animated.View>
          ) : null}
          {archived.length ? (
            <View style={{ marginTop: 16 }}>
              <Tap accessibilityRole="button" accessibilityState={{ expanded: archivedOpen }} accessibilityLabel={`Archived projects, ${archived.length}`}
                onPress={() => setArchivedOpen((v) => !v)} style={s.archiveHead}>
                {archivedOpen ? <ChevronDown size={17} color={t.colors.textSecondary} /> : <ChevronRight size={17} color={t.colors.textSecondary} />}
                <Text style={s.archiveTitle}>Archived projects</Text>
                <Text style={s.archiveCount}>{archived.length}</Text>
              </Tap>
              {archivedOpen ? <Animated.View entering={reduced ? undefined : FadeIn.duration(160)}><ListGroup>{archived.map(row)}</ListGroup></Animated.View> : null}
            </View>
          ) : null}
          <Footnote>Archiving or deleting a project keeps its chats and drafts.</Footnote>
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
  return (
    <Tap feedback="selection" scaleTo={0.99} accessibilityLabel={`${project.name}, ${projectCountLabel(project)}${project.private ? ', only you' : ''}${project.archived ? ', archived' : ''}`}
      accessibilityHint={onMenu ? 'Long-press for project options' : undefined} onPress={onOpen}
      onLongPress={onMenu} delayLongPress={350}
      style={({ pressed, hovered }) => [(pressed || hovered) && { backgroundColor: t.colors.pressed }]}>
      <ListRow icon={<Folder />} title={project.name} value={projectCountLabel(project)} chevron={!onMenu}
        right={onMenu ? <IconButton label={`Options for ${project.name}`} size={36} onPress={(e) => { e.stopPropagation(); onMenu(); }}>
          <MoreHorizontal size={17} color={t.colors.textSecondary} /></IconButton> : undefined} />
    </Tap>
  );
}

const useStyles = makeStyles((t) => ({
  notice: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginTop: 18, padding: t.space.lg, borderRadius: t.radius.lg,
    backgroundColor: t.colors.warningSoft },
  noticeText: { ...t.type.callout, color: t.colors.textSecondary, flex: 1 },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 34, paddingHorizontal: 18 },
  emptyIcon: { width: 64, height: 64, borderRadius: t.radius.pill, backgroundColor: t.colors.surfaceSunken, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { ...t.type.callout, color: t.colors.text, textAlign: 'center' },
  emptyText: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center', maxWidth: 440 },
  archiveHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, paddingHorizontal: 4 },
  archiveTitle: { ...t.type.bodyStrong, color: t.colors.text, flex: 1 },
  archiveCount: { ...t.type.caption, color: t.colors.textTertiary },
}));
