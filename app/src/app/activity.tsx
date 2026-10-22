import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Ban, KeyRound, ShieldCheck, Smartphone, UserPlus } from '../components/icons';
import { Screen } from '../components/Screen';
import { withSelectedServer } from '../components/ServerScreen';
import { Button, Card, Skeleton } from '../components/ui';
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
    const color = e.outcome === 'refused' ? t.colors.danger : t.colors.onAccentSoft;
    if (e.outcome === 'refused') return <Ban size={16} color={color} />;
    if (e.action === 'approval') return <ShieldCheck size={16} color={color} />;
    if (e.action === 'pairing_code' || e.action === 'device.paired') return <UserPlus size={16} color={color} />;
    if (e.action.includes('token') || e.action.includes('key') || e.action === 'device.verified') return <KeyRound size={16} color={color} />;
    return <Smartphone size={16} color={color} />;
  };

  return (
    <Screen title="Activity" subtitle="Changes to who can use your agent, approvals, and requests the server turned away. Kept for 180 days.">
      {error ? <Text style={s.error}>{error}</Text> : null}
      {entries === null ? (
        <View style={{ gap: 10, marginTop: 12 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={58} radius={16} />)}</View>
      ) : entries.length === 0 ? (
        <Card style={{ marginTop: 12 }}><Text style={s.summary}>Nothing yet.</Text></Card>
      ) : (
        <Card style={{ marginTop: 12, paddingVertical: 4 }}>
          {entries.map((e, i) => (
            <View key={e.id} style={[s.row, i > 0 && s.divider]} accessible accessibilityLabel={`${LABELS[e.action] ?? e.action}. ${e.summary}. ${e.device_name || 'Server terminal'}, ${agoText(e.ts)}`}>
              <View style={[s.icon, { backgroundColor: e.outcome === 'refused' ? t.colors.dangerSoft : t.colors.accentSoft }]}>{icon(e)}</View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.action}>{LABELS[e.action] ?? e.action}</Text>
                {e.summary ? <Text style={s.summary} numberOfLines={3}>{e.summary}</Text> : null}
                <Text style={s.meta}>{e.device_name || 'Server terminal'} · {agoText(e.ts)}</Text>
              </View>
            </View>
          ))}
        </Card>
      )}
      {entries?.length && more ? <Button title="Load older" variant="ghost" onPress={() => load(entries[entries.length - 1].id)} /> : null}
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', gap: 12, paddingVertical: 12 },
  divider: { borderTopWidth: 1, borderTopColor: t.colors.border },
  icon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  action: { ...t.type.body, fontFamily: t.fonts.semibold, color: t.colors.text },
  summary: { ...t.type.callout, color: t.colors.textSecondary },
  meta: { ...t.type.caption, color: t.colors.textTertiary, marginTop: 2 },
  error: { ...t.type.callout, color: t.colors.danger, marginTop: 8 },
}));
