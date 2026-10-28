import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Button, ConfirmButton, Footnote, ListGroup, ListRow, LoadError, SectionHeader } from '../../components/ui';
import { api, signedApi } from '../../lib/api';
import { makeStyles } from '../../lib/themeContext';
import type { Server } from '../../lib/types';

type Status = {
  profile: string;
  provider: { available: boolean; active: string; providers: {name: string; status: string; configured: boolean}[] };
  pending: { available: boolean; entries: {id: string; summary: string; origin: string; payload: Proposal}[] };
};
type Operation = {action: string; content?: string; matched_entry?: string; old_text?: string};
type Proposal = Operation & {target: string; operations?: Operation[]};

export function MemoryStatus({ server, revision, onReviewed }: { server: Server; revision: number; onReviewed: () => void }) {
  const s = useStyles();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try { setStatus(await api<Status>(server, '/api/memory/status')); setError(''); }
    catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, [server.id, revision]);
  const review = async (id: string, decision: 'approve' | 'reject') => {
    if (busy) return;
    setBusy(true); setError('');
    try { await signedApi(server, 'POST', '/api/memory/review', { id, decision }); await load(); onReviewed(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <View>
    <SectionHeader title="Memory source" />
    {error ? <LoadError message={error} onRetry={load} /> : null}
    {!status && !error ? <Footnote>Loading memory status…</Footnote> : null}
    {status ? <>
      <ListGroup>
        <ListRow title="Profile" value={status.profile} />
        <ListRow title="External provider" value={status.provider.available ? status.provider.active || 'None — built-in memory' : 'Status unavailable'} />
        {status.provider.providers.filter(p => p.name === status.provider.active).map(p =>
          <ListRow key={p.name} title={p.name} value={p.status} subtitle={p.configured ? 'Configured' : 'Needs setup in Hermes'} />)}
      </ListGroup>
      <Footnote>The notes below are Hermes’s built-in memory. An external provider can retain additional information.</Footnote>
      <SectionHeader title="Pending memory changes" />
      {!status.pending.available ? <Footnote>This Hermes version does not expose pending memory review.</Footnote> :
        status.pending.entries.length ? status.pending.entries.map(p => <View key={p.id} style={s.proposal}>
          <Text style={s.text}>{p.summary}</Text>
          <Footnote>{p.origin === 'background_review' ? 'Background review' : 'Agent proposal'}</Footnote>
          {(p.payload.operations ?? [p.payload]).map((op, i) => <View key={i} style={{gap: 6}}>
            <Text style={s.text}>{op.action} · {p.payload.target === 'user' ? 'About you' : 'Its notes'}</Text>
            {op.matched_entry || op.old_text ? <><Footnote>Current entry</Footnote><Text selectable style={s.text}>{op.matched_entry ?? op.old_text}</Text></> : null}
            {op.content ? <><Footnote>Proposed content</Footnote><Text selectable style={s.text}>{op.content}</Text></> : null}
          </View>)}
          <View style={s.actions}>
            <ConfirmButton title="Approve change" loading={busy} onConfirm={() => review(p.id, 'approve')} />
            <ConfirmButton title="Reject change" loading={busy} onConfirm={() => review(p.id, 'reject')} />
          </View>
        </View>) : <Footnote>No memory changes waiting for review.</Footnote>}
    </> : null}
    <Button title="Memory review settings" variant="secondary" onPress={() => router.push('/advanced-config')} />
    <Footnote>Agent configuration → Memory controls approval, review reminders and background review. Enabled describes configuration, not whether a review is running.</Footnote>
  </View>;
}

const useStyles = makeStyles(t => ({
  text: { ...t.type.callout, color: t.colors.text },
  proposal: { gap: t.space.sm, paddingVertical: t.space.md, borderBottomWidth: 1, borderBottomColor: t.colors.border },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm },
}));
