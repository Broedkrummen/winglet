import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Screen } from '../components/Screen';
import { Button, ConfirmButton, Field, Footnote, ListGroup, ListRow, SectionHeader } from '../components/ui';
import { useLock } from '../lib/appLock';
import { useApp } from '../lib/store';
import { makeStyles } from '../lib/themeContext';
import { connectPersonalSync, disconnectPersonalSync, invitePersonalDevice, personalSyncMembers,
  refreshPersonalSync, resolvePersonalConflict, revokePersonalDevice, usePersonalSync,
  type Conflict, type SyncMember } from '../features/sync/runtime';
import type { Value } from '../features/sync/model';
import { RetainedFiles } from '../features/sync/RetainedFiles';
import { SubmissionRecovery } from '../features/sync/SubmissionRecovery';
import { CurrentRetainedFiles } from '../features/sync/CurrentRetainedFiles';

export default function SyncSettings() {
  const s = useStyles();
  const sync = usePersonalSync();
  const servers = useApp(state => state.servers);
  const selection = useApp(state => state.selection);
  const locked = useLock(state => state.locked);
  const [selected, setSelected] = useState(selection.serverId ?? servers[0]?.id);
  const roots = servers.filter(server => !server.parent);
  const selectedServer = servers.find(server => server.id === selected);
  const server = roots.find(root => root.id === (selectedServer?.parent ?? selected)) ?? roots[0];
  const [token, setToken] = useState('');
  const [invitation, setInvitation] = useState<{ token: string; expires_at: number } | null>(null);
  const [members, setMembers] = useState<SyncMember[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const loadMembers = async () => { if (sync.home) setMembers(await personalSyncMembers()); };
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not complete sync setup. Try again.'); }
    finally { setBusy(false); }
  };
  useEffect(() => { void loadMembers().catch(e => setError((e as Error).message)); }, [sync.home?.groupId, sync.lastSync]);
  useEffect(() => { if (locked) setInvitation(null); }, [locked]);
  useEffect(() => {
    if (!invitation) return;
    const timer = setTimeout(() => setInvitation(null), Math.max(0, invitation.expires_at * 1000 - Date.now()));
    return () => clearTimeout(timer);
  }, [invitation]);

  return <Screen title="Sync" onRefresh={async () => { await refreshPersonalSync(); await loadMembers(); }}>
    <Footnote>Keep your devices connected through one Hermes server you choose. Only devices you explicitly link can read your shared app state.</Footnote>
    {error || sync.error ? <Text style={s.error} accessibilityRole="alert">{error || sync.error}</Text> : null}
    {!sync.home ? <>
      <SectionHeader title="Choose your sync home" />
      <ListGroup>
        {roots.map(root => <ListRow key={root.id} title={root.bot.title} subtitle={root.bot.description || undefined}
          value={root.id === server?.id ? 'Selected' : undefined} onPress={() => setSelected(root.id)} />)}
      </ListGroup>
      {!server ? <Footnote>Pair a Hermes server first, then return here.</Footnote> : <View style={s.actions}>
        <Button title="Use as my sync home" loading={busy} onPress={() => void run(() => connectPersonalSync(server))} />
        <Footnote>Already set up another device? Select the same server and paste its invitation below. Different values will be kept for you to choose.</Footnote>
        <Field label="Device invitation" value={token} onChangeText={setToken} autoCapitalize="none" autoCorrect={false} secureTextEntry />
        <Button title="Link this device" variant="secondary" disabled={!token.trim()} loading={busy}
          onPress={() => void run(async () => { await connectPersonalSync(server, token.trim()); setToken(''); })} />
      </View>}
    </> : <>
      <SectionHeader title="Your sync home" />
      <ListGroup>
        <ListRow title={servers.find(item => item.id === sync.home!.serverId)?.bot.title ?? 'Paired sync home'}
          subtitle={sync.status === 'ready' ? 'Up to date' : sync.status === 'syncing' ? 'Syncing…' : sync.status === 'offline' ? 'Offline · local changes are kept' : sync.status === 'locked' ? 'Paused while locked' : 'Needs attention'} />
        <ListRow title="Pending changes" value={String(sync.pending)} />
        <ListRow title="Choices needed" value={String(sync.conflicts.length)} />
      </ListGroup>
      <Footnote>Settings, drafts, attached files and reply context sync now. The remaining libraries are still being added. Pairing credentials, biometrics and device permissions stay on each device. Sending a shared draft needs a reachable sync home.</Footnote>
      {sync.deferredDrafts ? <Footnote>A draft changed on another device. Its incoming composition will be applied after you leave that chat; your active composer stays as it is.</Footnote> : null}
      <View style={s.actions}>
        <Button title="Sync now" variant="secondary" loading={busy} onPress={() => void run(refreshPersonalSync)} />
        <Button title="Invite another device" disabled={sync.status === 'offline' || locked} loading={busy}
          onPress={() => void run(async () => setInvitation(await invitePersonalDevice()))} />
        {invitation ? <>
          <Field label="Single-use invitation" value={invitation.token} editable={false} />
          <Footnote>Expires {new Date(invitation.expires_at * 1000).toLocaleTimeString()}. On your other device, pair this same server and open Settings → Sync.</Footnote>
          <Button title="Copy invitation" variant="secondary" onPress={() => void Clipboard.setStringAsync(invitation.token).catch(e => setError((e as Error).message))} />
        </> : null}
      </View>
      <SectionHeader title="Linked devices" />
      <ListGroup>{members.map(member => <View key={member.id}>
        <ListRow title={member.name} subtitle={member.platform || 'Linked device'} value={member.id === sync.home?.deviceId ? 'This device' : undefined} />
        <View style={s.deviceAction}><ConfirmButton title="Unlink" confirmTitle={`Unlink ${member.name}?`} loading={busy}
          onConfirm={() => run(async () => { await revokePersonalDevice(member.id); await loadMembers(); })} /></View>
      </View>)}</ListGroup>
      {sync.conflicts.length ? <SectionHeader title="Choose what to keep" /> : null}
      {sync.conflicts.map(conflict => <ConflictChoice key={`${conflict.kind}:${conflict.id}:${conflict.field}`} conflict={conflict}
        members={members} disabled={busy || sync.pending > 0} onChoose={choice => run(() => resolvePersonalConflict(conflict, choice))} />)}
      <SectionHeader title="On this device" />
      <Footnote>Disconnect stops syncing here. Use Unlink above to revoke a device's access at the sync home.</Footnote>
      <ConfirmButton title="Disconnect sync home" confirmTitle="Disconnect? Local drafts and the recovery journal will stay on this device."
        onConfirm={() => run(disconnectPersonalSync)} loading={busy} />
    </>}
    <SubmissionRecovery />
    <CurrentRetainedFiles />
    <RetainedFiles />
  </Screen>;
}

function ConflictChoice({ conflict, members, disabled, onChoose }: {
  conflict: Conflict; members: SyncMember[]; disabled: boolean; onChoose: (value: Value) => Promise<unknown>;
}) {
  const s = useStyles();
  const [combined, setCombined] = useState('');
  const [expanded, setExpanded] = useState(false);
  const label = conflict.field.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
  const canCombine = conflict.candidates.every(candidate => !candidate.deleted && typeof candidate.value === 'string');
  return <View style={s.conflict}>
    <Text style={s.heading}>{label.charAt(0).toUpperCase() + label.slice(1)}</Text>
    <Text style={s.context}>{conflict.kind === 'draft' ? `Draft · ${conflict.id}` : conflict.kind}</Text>
    {conflict.candidates.map((candidate, index) => <View key={`${candidate.device_id}:${candidate.operation_id}:${index}`} style={s.candidate}>
      <Text style={s.context}>{members.find(member => member.id === candidate.device_id)?.name ?? 'Previously linked device'} · {new Date(candidate.at * 1000).toLocaleString()}</Text>
      <Text selectable numberOfLines={expanded ? undefined : 8} style={s.value}>{candidate.deleted ? 'Removed' : typeof candidate.value === 'string' ? candidate.value || '(empty)' : JSON.stringify(candidate.value, null, 2)}</Text>
      <Button title="Keep this value" variant="secondary" disabled={disabled} onPress={() => void onChoose(candidate)} />
    </View>)}
    <Button title={expanded ? 'Show less' : 'Read full values'} variant="ghost" onPress={() => setExpanded(!expanded)} />
    {canCombine ? <>
      <Field label="Or write a combined value" value={combined} onChangeText={setCombined} multiline />
      <Button title="Keep combined value" disabled={disabled || !combined.trim()} onPress={() => void onChoose({ deleted: false, value: combined })} />
    </> : null}
  </View>;
}

const useStyles = makeStyles(t => ({
  actions: { gap: t.space.md, marginVertical: t.space.md },
  error: { ...t.type.body, color: t.colors.danger },
  conflict: { gap: t.space.md, marginBottom: t.space.xl },
  heading: { ...t.type.heading, color: t.colors.text },
  context: { ...t.type.footnote, color: t.colors.textSecondary },
  candidate: { gap: t.space.sm, padding: t.space.md, backgroundColor: t.colors.surfaceSunken, borderRadius: t.radius.md },
  value: { ...t.type.body, color: t.colors.text },
  deviceAction: { paddingHorizontal: t.space.lg, paddingBottom: t.space.md, alignItems: 'flex-start' as const },
}));
