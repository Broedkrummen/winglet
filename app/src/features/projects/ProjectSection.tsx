import { router, usePathname } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { ChevronDown, ChevronRight, Folder, MoreHorizontal, Plus } from '../../components/icons';
import { haptic } from '../../lib/haptics';
import { useApp } from '../../lib/store';
import { makeStyles, useTheme } from '../../lib/themeContext';
import type { Project, Server } from '../../lib/types';
import { IconButton, Tap } from '../../components/ui';
import { ProjectCreateSheet, ProjectMenuSheet } from './ProjectSheets';
import { projectCountLabel } from './logic';

const useStyles = makeStyles((t) => ({
  head: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, paddingLeft: 10, paddingRight: 4, borderRadius: 12 },
  heading: { ...t.type.caption, fontFamily: t.fonts.semibold, color: t.colors.textSecondary, flex: 1, letterSpacing: 0.2 },
  count: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textTertiary },
  row: { flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 42, paddingLeft: 12, paddingRight: 2, borderRadius: 12 },
  active: { backgroundColor: t.colors.pressed },
  name: { ...t.type.callout, color: t.colors.text, flex: 1 },
  small: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textTertiary, paddingHorizontal: 12, paddingVertical: 6 },
  more: { ...t.type.caption, fontFamily: t.fonts.medium, color: t.colors.textSecondary },
  link: { flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 40, paddingHorizontal: 12, borderRadius: 12 },
}));

/**
 * The compact Projects group in the existing sidebar. It lists the selected bot's active projects,
 * collapses to one row, and treats archived projects as a separate place in All projects.
 */
export function ProjectSection({ server, onNavigate }: { server: Server; onNavigate?: () => void }) {
  const t = useTheme();
  const s = useStyles();
  const pathname = usePathname();
  const snapshot = useApp((st) => st.runtime[server.id]?.projects);
  const runtime = useApp((st) => st.runtime[server.id]);
  const [expanded, setExpanded] = useState(true);
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const feature = !!runtime?.info?.features?.projects;
  const online = feature && runtime?.status === 'online';
  if (!snapshot) return null;
  const active = snapshot.projects.filter((p) => !p.archived);
  const archived = snapshot.projects.filter((p) => p.archived);
  const shown = active.slice(0, 6);
  const open = (project: Project) => {
    haptic.selection();
    onNavigate?.();
    useApp.getState().select(server.id);
    router.navigate(`/project/${server.id}/${project.id}`);
  };
  return (
    <>
      <Tap accessibilityRole="button" accessibilityLabel={`Projects, ${active.length} active`}
        accessibilityState={{ expanded }} accessibilityHint={expanded ? 'Collapse projects' : 'Expand projects'}
        onPress={() => { haptic.selection(); setExpanded((v) => !v); }} style={s.head}>
        {expanded ? <ChevronDown size={16} color={t.colors.textSecondary} /> : <ChevronRight size={16} color={t.colors.textSecondary} />}
        <Text style={s.heading}>PROJECTS</Text>
        {active.length ? <Text style={s.count}>{active.length}</Text> : null}
      </Tap>
      {expanded ? (
        <>
          {shown.map((project) => {
            const selected = pathname === `/project/${server.id}/${project.id}`;
            return (
              <Tap key={project.id} accessibilityLabel={`${project.name}, ${projectCountLabel(project)}`}
                accessibilityHint={project.can_manage && online ? 'Long-press for project options' : undefined}
                accessibilityState={{ selected }}
                onPress={() => open(project)} onLongPress={() => { if (project.can_manage && online) setMenu(project.id); }}
                delayLongPress={350} style={({ pressed, hovered }) => [s.row, (selected || pressed || hovered) && s.active]}>
                <Folder size={16} color={selected ? t.colors.onAccentSoft : t.colors.textSecondary} />
                <Text style={s.name} numberOfLines={1}>{project.name}</Text>
                <Text style={s.count} accessibilityElementsHidden>{project.chat_count || ''}</Text>
                {project.can_manage && online ? (
                  <IconButton label={`Options for ${project.name}`} size={30} onPress={(e) => { e.stopPropagation(); setMenu(project.id); }}>
                    <MoreHorizontal size={14} color={t.colors.textTertiary} />
                  </IconButton>
                ) : <View style={{ width: 4 }} />}
              </Tap>
            );
          })}
          {!active.length ? <Text style={s.small}>Group chats by topic, on every device.</Text> : null}
          {active.length > 6 ? <Text style={s.small}>{active.length - 6} more in All projects</Text> : null}
          <Tap accessibilityLabel="All projects" onPress={() => { onNavigate?.(); useApp.getState().select(server.id); router.navigate('/projects'); }}
            style={({ pressed, hovered }) => [s.link, (pressed || hovered) && s.active]}>
            <Folder size={15} color={t.colors.textSecondary} />
            <Text style={s.more}>All projects</Text>
            {archived.length ? <Text style={s.count}>{archived.length} archived</Text> : null}
          </Tap>
          {online ? <Tap accessibilityLabel="New project" onPress={() => { haptic.selection(); setCreating(true); }}
            style={({ pressed, hovered }) => [s.link, (pressed || hovered) && s.active]}>
            <Plus size={15} color={t.colors.textSecondary} />
            <Text style={s.more}>New project</Text>
          </Tap> : null}
        </>
      ) : null}
      <ProjectCreateSheet server={server} visible={creating} onClose={() => setCreating(false)}
        onCreated={(id) => { onNavigate?.(); useApp.getState().select(server.id); router.navigate(`/project/${server.id}/${id}`); }} />
      <ProjectMenuSheet server={server} projectId={menu ?? ''} visible={!!menu} onClose={() => setMenu(null)}
        onDeleted={() => setMenu(null)} />
    </>
  );
}
