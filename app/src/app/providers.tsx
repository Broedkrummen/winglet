import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { CheckCircle2, Key, Plug } from '../components/icons';
import { Screen } from '../components/Screen';
import { withSelectedServer } from '../components/ServerScreen';
import { Sheet } from '../components/Sheet';
import { Button, ConfirmButton, Field, Footnote, ListGroup, ListRow, LoadError, SectionHeader, Skeleton } from '../components/ui';
import { api, serverKey, signedApi } from '../lib/api';
import { seal } from '../lib/crypto';
import { haptic } from '../lib/haptics';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';

type Provider = { slug: string; name: string; authenticated: boolean; is_current: boolean; auth_type: string; key_env: string;
  total_models: number; warning: string };

/** Where models come from: which providers are ready, and adding or removing an API key. */
export default withSelectedServer(ProvidersScreen);

function ProvidersScreen() {
  const t = useTheme();
  const s = useStyles();
  const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [error, setError] = useState('');

  const load = () => {
    if (!server) return;
    return api<{ providers: Provider[] }>(server, '/api/providers').then((d) => { setProviders(d.providers); setError(''); })
      .catch((e) => setError((e as Error).message));
  };
  useEffect(() => { load(); }, [server?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [allOthers, setAllOthers] = useState(false);

  const ready = (providers ?? []).filter((p) => p.authenticated);
  const keyed = (providers ?? []).filter((p) => !p.authenticated && p.auth_type === 'api_key' && p.key_env);
  const other = (providers ?? []).filter((p) => !p.authenticated && !(p.auth_type === 'api_key' && p.key_env));

  return (
    <Screen title="Providers"
      onRefresh={load}>
      {error && providers ? <Text style={s.error}>{error}</Text> : null}
      {!providers ? (error ? <LoadError message={error} onRetry={load} /> : (
        <View style={{ gap: 10, marginTop: 16 }}>{[0, 1, 2].map((i) => <Skeleton key={i} height={56} radius={16} />)}</View>
      )) : (
        <>
          <SectionHeader title="Ready" />
          <ListGroup>
            {ready.length ? ready.map((p) => (
              <ListRow key={p.slug} icon={<CheckCircle2 size={18} color={t.colors.success} />} iconColor={t.colors.success} title={p.name}
                subtitle={p.is_current ? 'In use' : undefined} value={`${p.total_models} models`}
                onPress={p.key_env ? () => setEditing(p) : undefined} chevron={!!p.key_env} />
            )) : <ListRow title="No providers ready" />}
          </ListGroup>
          {keyed.length ? (
            <>
              <SectionHeader title="Add with an API key" />
              <ListGroup>
                {keyed.map((p) => (
                  <ListRow key={p.slug} icon={<Key size={18} color={t.colors.textSecondary} />} title={p.name} value={p.key_env} onPress={() => setEditing(p)} />
                ))}
              </ListGroup>
            </>
          ) : null}
          {other.length ? (
            <>
              <SectionHeader title="Set up on the server" />
              <ListGroup>
                {(allOthers ? other : other.slice(0, 20)).map((p) => <ListRow key={p.slug} icon={<Plug size={18} color={t.colors.textSecondary} />} title={p.name} />)}
                {other.length > 20 && !allOthers ? <ListRow title={`Show all ${other.length}`} onPress={() => setAllOthers(true)} /> : null}
              </ListGroup>
              <Footnote>Run `hermes model` on the server to sign in.</Footnote>
            </>
          ) : null}
        </>
      )}
      <KeySheet provider={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
    </Screen>
  );
}

function KeySheet({ provider, onClose, onSaved }: { provider: Provider | null; onClose: () => void; onSaved: () => void }) {
  const t = useTheme();
  const s = useStyles();
  const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [last, setLast] = useState<Provider | null>(provider);
  if (provider && provider !== last) { setLast(provider); setValue(''); setError(''); }
  const p = provider ?? last;
  const close = () => { setValue(''); setError(''); onClose(); };

  const save = async () => {
    if (!server || !p) return;
    setBusy(true);
    setError('');
    try {
      // Sealed to the server's key (checked against the one pinned at pairing) and bound to this phone.
      const key = await serverKey(server.url, server.fingerprint);
      if (!key) throw new Error('Update Winglet on the server first.');
      await signedApi(server, 'POST', '/api/providers/key', { sealed: seal(key, 'provider-key', server.deviceId, { env: p.key_env, value: value.trim() }) });
      haptic.success();
      setValue('');
      onSaved();
    } catch (e) {
      haptic.error();
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!server || !p) return;
    setBusy(true);
    setError('');
    try {
      await signedApi(server, 'DELETE', `/api/providers/key/${p.key_env}`);
      haptic.success();
      onSaved();
    } catch (e) {
      haptic.error();
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!p) return null;
  return (
    <Sheet visible={!!provider} onClose={close} title={p.name} scrollable>
      <View style={{ gap: 14, paddingHorizontal: 4 }}>
        <Field value={value} onChangeText={setValue} placeholder={p.authenticated ? 'Paste a new key to replace it' : `Paste your ${p.name} API key`}
          secureTextEntry autoCapitalize="none" autoCorrect={false} hint={`Saved as ${p.key_env} after validation.`} />
        <Footnote>Keys are encrypted for this server and never shown again.</Footnote>
        <Button title={p.authenticated ? 'Replace key' : 'Save key'} loading={busy} disabled={!value.trim()} onPress={save} />
        {p.authenticated ? <ConfirmButton title="Remove key" loading={busy} onConfirm={remove} accessibilityLabel={`Remove the ${p.name} key`} /> : null}
        {error ? <Text style={[s.note, { color: t.colors.danger, textAlign: 'center' }]}>{error}</Text> : null}
      </View>
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  note: { ...t.type.callout, color: t.colors.textSecondary },
  error: { ...t.type.callout, color: t.colors.danger, marginTop: 10 },
}));
