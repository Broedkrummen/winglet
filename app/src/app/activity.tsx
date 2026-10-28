import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Ban, KeyRound, ShieldCheck, Smartphone, UserPlus } from '../components/icons';
import { Screen } from '../components/Screen';
import { withSelectedServer } from '../components/ServerScreen';
import { Button, Footnote, ListGroup, ListRow, Skeleton } from '../components/ui';
import { agoText } from '../lib/agent';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { AuditEntry } from '../lib/types';

const LABELS: Record<string, string> = {
  'device.paired': 'Paired a device',
  'device.verified': 'Verified a device',
  'device.renamed': 'Renamed a device',
  'device.role': 'Changed a role',
  'device.removed': 'Removed a device',
  pairing_code: 'Made a pairing code',
  'token.rotated': 'Replaced an access token',
  'server_key.rotated': 'Replaced the encryption key',
  approval: 'Answered an approval',
  refused: 'Refused a request',
};

/** The server's record of control actions: who did what, when, and what was refused. Owners only. */
export default withSelectedServer(ActivityScreen);

function ActivityScreen() {
  const t = useTheme();
  const s = useStyles();
  const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [more, setMore] = useState(true);
  const [error, setError] = useState('');

  const load = async (before?: number) => {
    if (!server) return;
    try {
      const page = (await api<{ entries: AuditEntry[] }>(server, `/api/audit?limit=50${before ? `&before=${before}` : ''}`)).entries;
      setEntries((list) => (before ? [...(list ?? []), ...page] : page));
      setMore(page.length === 50);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => { load(); }, [server?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const icon = (e: AuditEntry) => {
    if (e.outcome === 'refused') return <Ban />;
    if (e.action === 'approval') return <ShieldCheck />;
    if (e.action === 'pairing_code' || e.action === 'device.paired') return <UserPlus />;
    if (e.action.includes('token') || e.action.includes('key') || e.action === 'device.verified') return <KeyRound />;
    return <Smartphone />;
  };

  return (
    <Screen title="Activity">
      {error ? <Text style={s.error}>{error}</Text> : null}
      {entries === null ? (
        <View style={{ gap: t.space.sm, marginTop: t.space.md }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={58} radius={16} />)}</View>
      ) : entries.length === 0 ? (
        <ListGroup style={{ marginTop: t.space.md }}><ListRow title="Nothing yet." /></ListGroup>
      ) : (
        <ListGroup style={{ marginTop: t.space.md }}>
          {entries.map((e) => (
            <ListRow key={e.id} icon={icon(e)} iconColor={e.outcome === 'refused' ? t.colors.danger : undefined}
              title={LABELS[e.action] ?? e.action}
              subtitle={[e.device_name || 'Server terminal', e.summary].filter(Boolean).join(' · ')}
              value={agoText(e.ts)} />
          ))}
        </ListGroup>
      )}
      {entries?.length ? <Footnote>Kept for 180 days.</Footnote> : null}
      {entries?.length && more ? <Button style={{ marginTop: t.space.md }} variant="ghost" title="Load older"
        onPress={() => load(entries[entries.length - 1].id)} /> : null}
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  error: { ...t.type.callout, color: t.colors.danger, marginTop: t.space.sm },
}));
