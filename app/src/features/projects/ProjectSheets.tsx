import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { ArrowDown, ArrowUp, Archive, ArchiveRestore, Folder, Pencil, Trash2 } from '../../components/icons';
import { Sheet, SheetAction } from '../../components/Sheet';
import { Button, Field } from '../../components/ui';
import { movedOrder, reorderableIds } from './logic';
import { isOwner, useApp } from '../../lib/store';
import { makeStyles, useTheme } from '../../lib/themeContext';
import type { Server } from '../../lib/types';

const useStyles = makeStyles((t) => ({
  form: { gap: 14, paddingHorizontal: 4, paddingBottom: 6 },
  note: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center' },
  error: { ...t.type.callout, color: t.colors.danger, textAlign: 'center' },
  tip: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textTertiary, paddingHorizontal: 8 },
}));

/** Create a project. Chat identity, drafts and Hermes sessions are untouched. */
export function ProjectCreateSheet({ server, visible, onClose, onCreated }: {
  server: Server; visible: boolean; onClose: () => void; onCreated?: (id: string) => void;
}) {
  const s = useStyles();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!visible) return;
    setName('');
    setError('');
    setBusy(false);
  }, [visible]);
  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const project = await useApp.getState().createProject(server.id, name.trim());
      if (project) {
        useApp.getState().toast({ serverId: server.id, title: 'Project created',
          body: project.private ? `“${project.name}” is private to this device.` : `“${project.name}” is on every owner device.` });
        onClose();
        onCreated?.(project.id);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="New project">
      <View style={s.form}>
        <Text style={s.note}>Group chats by topic. The project is saved on your server, so every device sees it.</Text>
        <Field label="Name" value={name} onChangeText={setName} placeholder="For example, Launch" autoFocus
          returnKeyType="done" onSubmitEditing={create} editable={!busy} maxLength={80} />
        <Text style={s.tip}>Chats keep their own messages, draft and Hermes session. Moving a chat only changes where it is listed.</Text>
        {error ? <Text style={s.error} accessibilityLiveRegion="polite">{error}</Text> : null}
        <Button title="Create project" onPress={create} loading={busy} disabled={!name.trim()} />
      </View>
    </Sheet>
  );
}

type Mode = 'menu' | 'rename' | 'delete';

/** Rename, reorder, archive or delete one project. Shared projects are owner-managed. */
export function ProjectMenuSheet({ server, projectId, visible, onClose, onDeleted }: {
  server: Server; projectId: string; visible: boolean; onClose: () => void; onDeleted?: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const project = useApp((st) => st.runtime[server.id]?.projects?.projects.find((p) => p.id === projectId));
  const snapshot = useApp((st) => st.runtime[server.id]?.projects);
  const runtime = useApp((st) => st.runtime[server.id]);
  const [mode, setMode] = useState<Mode>('menu');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!visible) return;
    setMode('menu');
    setBusy(false);
    setName(project?.name ?? '');
  }, [visible, projectId, project?.name]);
  const change = async (fn: () => Promise<unknown>, title: string, body: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      useApp.getState().toast({ serverId: server.id, title, body });
      onClose();
    } catch (e) {
      useApp.getState().toast({ serverId: server.id, title: "Couldn't change the project", body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const online = !!runtime?.info?.features?.projects && runtime.status === 'online';
  const projects = snapshot?.projects ?? [];
  const order = reorderableIds(snapshot, isOwner(runtime));
  const at = project ? order.indexOf(project.id) : -1;
  const up = project && at > 0 ? movedOrder(order, project.id, -1) : null;
  const down = project && at >= 0 && at < order.length - 1 ? movedOrder(order, project.id, 1) : null;
  const rename = async () => {
    if (!name.trim() || busy) return;
    await change(() => useApp.getState().renameProject(server.id, projectId, name.trim()), 'Project renamed',
      `Now called “${name.trim()}”.`);
  };
  const canManage = !!project?.can_manage;
  return (
    <Sheet visible={visible} onClose={() => { if (!busy) { setMode('menu'); onClose(); } }}
      title={mode === 'rename' ? 'Rename project' : mode === 'delete' ? 'Delete project?' : project?.name ?? 'Project'}>
      {!project ? <Text style={s.note}>This project is no longer here.</Text>
        : mode === 'rename' ? (
          <View style={s.form}>
            <Field value={name} onChangeText={setName} placeholder="Project name" autoFocus returnKeyType="done"
              onSubmitEditing={rename} editable={!busy} maxLength={80} />
            <Button title="Save name" onPress={rename} loading={busy} disabled={!name.trim()} />
            <Button title="Cancel" variant="secondary" onPress={() => setMode('menu')} disabled={busy} />
          </View>
        ) : mode === 'delete' ? (
          <View style={s.form}>
            <Text style={s.note}>“{project.name}” is removed from every device that can see it.</Text>
            <Text style={s.note}>Its chats stay in Chats with their messages, drafts, pins and Hermes sessions. Nothing is deleted.</Text>
            <Button title="Delete project only" variant="danger" loading={busy} onPress={async () => {
              setBusy(true);
              try {
                await useApp.getState().deleteProject(server.id, projectId);
                useApp.getState().toast({ serverId: server.id, title: 'Project deleted', body: 'Its chats are still in Chats.' });
                onClose();
                onDeleted?.();
              } catch (e) {
                useApp.getState().toast({ serverId: server.id, title: "Couldn't delete the project", body: (e as Error).message });
              } finally {
                setBusy(false);
              }
            }} />
            <Button title="Keep project" variant="secondary" onPress={() => setMode('menu')} disabled={busy} />
          </View>
        ) : (
          <>
            {!online ? <Text style={s.note}>Connect to your bot to change projects.</Text> : null}
            {!canManage ? <Text style={s.note}>This is a shared project. Only an owner can rename, reorder, archive or delete it. You can still move your own chats in and out.</Text> : null}
            {canManage && online ? (
              <>
                <SheetAction icon={<Pencil size={20} color={t.colors.text} />} label="Rename project"
                  onPress={() => { setName(project.name); setMode('rename'); }} />
                {up ? <SheetAction icon={<ArrowUp size={20} color={t.colors.text} />} label="Move up"
                  onPress={() => change(() => useApp.getState().reorderProjects(server.id, up), 'Project moved', 'The new order is on every device.')} /> : null}
                {down ? <SheetAction icon={<ArrowDown size={20} color={t.colors.text} />} label="Move down"
                  onPress={() => change(() => useApp.getState().reorderProjects(server.id, down!), 'Project moved', 'The new order is on every device.')} /> : null}
                {project.archived
                  ? <SheetAction icon={<ArchiveRestore size={20} color={t.colors.text} />} label="Restore project"
                    onPress={() => change(() => useApp.getState().setProjectArchived(server.id, projectId, false), 'Project restored', 'It is back in Projects.')} />
                  : <SheetAction icon={<Archive size={20} color={t.colors.text} />} label="Archive project"
                    onPress={() => change(() => useApp.getState().setProjectArchived(server.id, projectId, true), 'Project archived', 'Its chats are still in Chats. Find the project under Archived.')} />}
                <SheetAction icon={<Trash2 size={20} color={t.colors.danger} />} label="Delete project…" destructive
                  onPress={() => setMode('delete')} />
              </>
            ) : null}
            <SheetAction icon={<Folder size={20} color={t.colors.text} />} label={`${project.chat_count} ${project.chat_count === 1 ? 'chat' : 'chats'} in this project`}
              onPress={onClose} />
          </>
        )}
    </Sheet>
  );
}
