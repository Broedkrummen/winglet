import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { JobSheet } from '../components/JobSheet';
import { CustomMcp } from '../features/abilities/CustomMcp';
import { CheckCircle2, CircleAlert, ExternalLink, Plug, RefreshCw, Search, Trash2 } from '../components/icons';
import { Screen } from '../components/Screen';
import { withSelectedServer } from '../components/ServerScreen';
import { Sheet } from '../components/Sheet';
import { Button, Card, ConfirmButton, Field, Footnote, ListGroup, ListRow, LoadError, SearchField, SectionHeader, Skeleton, Toggle } from '../components/ui';
import { matches, missingEnv, prettyName, serverPlace, signsIn } from '../lib/abilities';
import { api, ApiError, serverKey, signedApi } from '../lib/api';
import { idempotencyKey } from '../lib/control';
import { seal } from '../lib/crypto';
import { haptic } from '../lib/haptics';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Job, McpCatalogEntry, McpInfo, McpServer, McpSignIn, McpTest, Server } from '../lib/types';

const SIGN_IN_POLL_MS = 2000;
const SIGN_IN_WAIT_MS = 10 * 60 * 1000;

/** MCP servers connect your agent to other apps and services. */
export default withSelectedServer(McpScreen);

function McpScreen() {
  const t = useTheme();
  const s = useStyles();
  const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [catalog, setCatalog] = useState<McpCatalogEntry[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState<McpServer | null>(null);
  const [adding, setAdding] = useState<McpCatalogEntry | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [reloading, setReloading] = useState(false);

  const load = useCallback(() => {
    if (!server) return;
    return Promise.all([
      api<McpInfo>(server, '/api/mcp').then((d) => { setInfo(d); setError(''); }).catch((e) => setError((e as Error).message)),
      api<{ entries: McpCatalogEntry[] }>(server, '/api/mcp/catalog').then((d) => setCatalog(d.entries)).catch(() => setCatalog([])),
    ]);
  }, [server]);
  useEffect(() => { load(); }, [load]);

  const available = useMemo(() => (catalog ?? []).filter((e) => !e.installed && matches(query, e.name, e.description)), [catalog, query]);
  if (!server) return null;
  const toast = (title: string, body = '') => useApp.getState().toast({ serverId: server.id, title, body });

  const toggle = async (x: McpServer, enabled: boolean) => {
    setInfo((d) => d && { ...d, servers: d.servers.map((y) => (y.name === x.name ? { ...y, enabled } : y)) });
    try {
      await signedApi(server, 'PUT', `/api/mcp/${encodeURIComponent(x.name)}`, { enabled });
      setInfo((d) => d && { ...d, needs_reload: true });
    } catch (e) {
      haptic.error();
      toast("Couldn't change that", (e as Error).message);
      load();
    }
  };
  const reload = async () => {
    setReloading(true);
    try {
      const r = await signedApi<{ message: string }>(server, 'POST', '/api/mcp/reload');
      haptic.success();
      toast('Reconnected', r.message.replace(/[*_`]/g, '').split('\n').filter((l) => l.trim()).slice(1).join(' · '));
      load();
    } catch (e) {
      haptic.error();
      toast("Couldn't reconnect", (e as Error).message);
    } finally {
      setReloading(false);
    }
  };

  return (
    <Screen title="MCP servers" onRefresh={load}>
      <CustomMcp server={server} onDone={load} />
      {error && info ? <Text style={s.error}>{error}</Text> : null}
      {!info ? (error ? <LoadError message={error} onRetry={load} /> : (
        <View style={{ gap: 12, marginTop: 20 }}>{[0, 1].map((i) => <Skeleton key={i} height={64} radius={16} />)}</View>
      )) : (
        <Animated.View entering={FadeIn}>
          {info.needs_reload ? (
            <Card style={s.banner}>
              <RefreshCw size={18} color={t.colors.textSecondary} />
              <Text style={s.bannerText}>
                {info.can_reload ? 'Reconnect to put your changes to work.' : 'Restart the server to put your changes to work.'}
              </Text>
              {info.can_reload ? <Button size="sm" title="Reconnect" loading={reloading} disabled={reloading} onPress={reload} /> : null}
            </Card>
          ) : null}

          <SectionHeader title="Your servers" />
          {info.servers.length ? (
            <ListGroup>
              {info.servers.map((x) => (
                <ListRow key={x.name} icon={<Plug size={18} color={x.enabled ? t.colors.textSecondary : t.colors.textTertiary} />}
                  title={prettyName(x.name)} value={serverPlace(x)} subtitle={x.source === 'plugin' ? `From ${x.plugin}` : undefined}
                  onPress={() => setOpen(x)} chevron={false}
                  right={x.source === 'plugin' ? undefined
                    : <Toggle label={`${x.name} server`} value={x.enabled} onValueChange={(on) => toggle(x, on)} />} />
              ))}
            </ListGroup>
          ) : (
            <ListGroup><ListRow title="No servers yet. Add one below." /></ListGroup>
          )}

          <SectionHeader title="Add a server" />
          <SearchField value={query} onChangeText={setQuery} placeholder="Search Linear, Notion, GitHub…" />
          <Footnote>Approved servers from Hermes.</Footnote>
          {!catalog ? <Skeleton height={64} radius={16} style={{ marginTop: 12 }} /> : available.length ? (
            <ListGroup style={{ marginTop: 12 }}>
              {available.map((e) => (
                <ListRow key={e.name} title={prettyName(e.name)} onPress={() => setAdding(e)} />
              ))}
            </ListGroup>
          ) : (
            <View style={s.empty}>
              <Search size={22} color={t.colors.textTertiary} />
              <Text style={s.emptyText}>{query ? `Nothing matches "${query}".` : 'You have added every server in the list.'}</Text>
            </View>
          )}
        </Animated.View>
      )}

      <ServerSheet server={server} item={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); load(); }} />
      <AddSheet server={server} entry={adding} onClose={() => setAdding(null)}
        onJob={(j) => { setAdding(null); setJob(j); }}
        onAdded={(e) => {
          setAdding(null);
          haptic.success();
          load();
          if (e.auth_type === 'oauth') {
            setOpen({ name: e.name, transport: 'http', url: e.url, command: null, auth: 'oauth', enabled: true, source: 'config', plugin: null });
          } else {
            toast(`${prettyName(e.name)} added`, 'Reconnect to start using it.');
          }
        }} />
      <JobSheet server={server} job={job} onClose={() => setJob(null)} onDone={load} />
    </Screen>
  );
}

/** One server: test it, sign in, or remove it. */
function ServerSheet({ server, item, onClose, onChanged }: { server: Server; item: McpServer | null; onClose: () => void; onChanged: () => void }) {
  const t = useTheme();
  const s = useStyles();
  const [last, setLast] = useState<McpServer | null>(null);
  const [test, setTest] = useState<McpTest | null>(null);
  const [busy, setBusy] = useState<'test' | 'sign-in' | 'remove' | null>(null);
  const [signIn, setSignIn] = useState<McpSignIn | null>(null);
  const flow = useRef<string | null>(null);
  if (item && item !== last) { setLast(item); setTest(null); setSignIn(null); flow.current = null; }
  const x = item ?? last;

  // Follow a sign-in while the page is open in the browser, until it comes back.
  useEffect(() => {
    if (!signIn || signIn.status === 'approved' || signIn.status === 'error') return;
    const started = Date.now();
    const id = setInterval(() => {
      if (Date.now() - started > SIGN_IN_WAIT_MS) { clearInterval(id); return; }
      api<{ sign_in: McpSignIn }>(server, `/api/mcp/sign-in/${signIn.id}`).then((r) => {
        if (flow.current !== r.sign_in.id) return;
        setSignIn(r.sign_in);
        if (r.sign_in.status === 'approved') haptic.success();
        if (r.sign_in.status === 'error') haptic.error();
      }).catch(() => undefined);
    }, SIGN_IN_POLL_MS);
    return () => clearInterval(id);
  }, [signIn?.id, signIn?.status, server]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    if (signIn && flow.current && signIn.status !== 'approved' && signIn.status !== 'error') {
      signedApi(server, 'DELETE', `/api/mcp/sign-in/${flow.current}`).catch(() => undefined);
    }
    onClose();
  };
  if (!x) return null;

  const runTest = async () => {
    setBusy('test');
    setTest(null);
    try {
      setTest(await signedApi<McpTest>(server, 'POST', `/api/mcp/${encodeURIComponent(x.name)}/test`));
    } catch (e) {
      setTest({ ok: false, error: (e as Error).message, tools: [] });
    } finally {
      setBusy(null);
    }
  };
  const startSignIn = async () => {
    setBusy('sign-in');
    try {
      const r = await signedApi<{ sign_in: McpSignIn }>(server, 'POST', `/api/mcp/${encodeURIComponent(x.name)}/sign-in`, { callback_base: server.url });
      flow.current = r.sign_in.id;
      setSignIn(r.sign_in);
      if (r.sign_in.authorization_url) await Linking.openURL(r.sign_in.authorization_url);
    } catch (e) {
      setSignIn({ id: '', server: x.name, status: 'error', authorization_url: null, error: (e as Error).message, tools: [] });
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy('remove');
    try {
      await signedApi(server, 'DELETE', `/api/mcp/${encodeURIComponent(x.name)}`);
      haptic.success();
      onChanged();
    } catch (e) {
      haptic.error();
      setTest({ ok: false, error: (e as Error).message, tools: [] });
    } finally {
      setBusy(null);
    }
  };

  const waiting = signIn && (signIn.status === 'authorization_required' || signIn.status === 'starting');
  return (
    <Sheet visible={!!item} onClose={close} title={prettyName(x.name)}>
      <View style={{ gap: 14, paddingHorizontal: 4 }}>
        <ListGroup>
          <ListRow title={x.url ? 'Connects to' : 'Runs on the server'} value={serverPlace(x)} />
          <ListRow title="Signs in" value={signsIn(x) ? 'On a web page' : x.auth === 'header' ? 'With a key' : x.url ? 'No sign-in' : 'With keys on the server'} />
          {x.source === 'plugin' ? <ListRow title="Comes with" value={x.plugin ?? 'a plugin'} /> : null}
        </ListGroup>

        {signIn ? (
          <View style={[s.result, { backgroundColor: signIn.status === 'approved' ? t.colors.successSoft : signIn.status === 'error' ? t.colors.dangerSoft : t.colors.surfaceSunken }]}
            accessibilityLiveRegion="polite">
            {waiting ? <ActivityIndicator color={t.colors.textSecondary} />
              : signIn.status === 'approved' ? <CheckCircle2 size={18} color={t.colors.success} /> : <CircleAlert size={18} color={t.colors.danger} />}
            <Text style={s.resultText}>
              {waiting ? 'Finish signing in on the page that opened, then come back here.'
                : signIn.status === 'approved' ? `Signed in. ${signIn.tools.length} tool${signIn.tools.length === 1 ? '' : 's'} ready: ${signIn.tools.slice(0, 6).join(', ')}`
                : signIn.error || 'The sign-in didn\'t finish.'}
            </Text>
          </View>
        ) : null}
        {waiting && signIn.authorization_url ? (
          <Button title="Open the sign-in page again" variant="ghost" icon={<ExternalLink size={16} color={t.colors.accent} />}
            onPress={() => Linking.openURL(signIn.authorization_url as string)} />
        ) : null}

        {test ? (
          <View style={[s.result, { backgroundColor: test.ok ? t.colors.successSoft : t.colors.dangerSoft }]} accessibilityLiveRegion="polite">
            {test.ok ? <CheckCircle2 size={18} color={t.colors.success} /> : <CircleAlert size={18} color={t.colors.danger} />}
            <Text style={s.resultText}>
              {test.ok ? `Connected. ${test.tools.length} tool${test.tools.length === 1 ? '' : 's'}: ${test.tools.slice(0, 6).map((tool) => tool.name).join(', ')}`
                : test.error || 'It didn\'t connect.'}
            </Text>
          </View>
        ) : null}

        <Button title="Test connection" variant="secondary" loading={busy === 'test'} disabled={!!busy} onPress={runTest} />
        {signsIn(x) ? <Button title={signIn?.status === 'approved' ? 'Sign in again' : 'Sign in'} loading={busy === 'sign-in'}
          disabled={!!busy} onPress={startSignIn} /> : null}
        {x.source !== 'plugin' ? (
          <ConfirmButton title="Remove" confirmTitle="Tap again to remove it and its keys" icon={<Trash2 size={16} color={t.colors.danger} />}
            loading={busy === 'remove'} onConfirm={remove} accessibilityLabel={`Remove ${x.name}`} />
        ) : null}
      </View>
    </Sheet>
  );
}

/** A catalog entry: what it connects to or runs, the keys it needs, and Add. */
function AddSheet({ server, entry, onClose, onJob, onAdded }: {
  server: Server; entry: McpCatalogEntry | null; onClose: () => void; onJob: (job: Job) => void; onAdded: (e: McpCatalogEntry) => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const [last, setLast] = useState<McpCatalogEntry | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (entry && entry !== last) { setLast(entry); setValues({}); setError(''); }
  const e = entry ?? last;
  if (!e) return null;

  const add = async () => {
    setBusy(true);
    setError('');
    try {
      const env = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
      const body: Record<string, unknown> = { name: e.name, idempotency_key: idempotencyKey() };
      if (Object.keys(env).length) {
        // Sealed to the server's key (checked against the one pinned at pairing) and bound to this phone.
        const key = await serverKey(server.url, server.fingerprint);
        if (!key) throw new Error('Update Winglet on the server first.');
        body.sealed = seal(key, 'mcp-env', server.deviceId, { env });
      }
      const r = await signedApi<{ job?: Job }>(server, 'POST', '/api/mcp', body);
      setValues({});
      if (r.job) onJob(r.job); else onAdded(e);
    } catch (err) {
      haptic.error();
      setError(err instanceof ApiError && err.status === 409 ? 'Something else is in progress on the server. Try again in a minute.' : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const missing = missingEnv(e, values);
  return (
    <Sheet visible={!!entry} onClose={onClose} title={prettyName(e.name)}>
      <View style={{ gap: 14, paddingHorizontal: 4 }}>
        <Text style={s.description}>{e.description}</Text>
        <View style={s.trust}>
          <Text style={s.trustLabel}>{e.url ? 'Connects to' : 'Runs on your server'}</Text>
          <Text selectable style={s.code}>{e.url ?? [e.command, ...e.args].filter(Boolean).join(' ')}</Text>
          {e.install_url ? <Text style={s.trustLabel}>Downloads and builds {e.install_url} first</Text> : null}
        </View>
        {e.auth_type === 'oauth' ? <Text style={s.note}>You sign in to {prettyName(e.name)} on its own page after adding it.</Text> : null}
        {e.required_env.map((env) => (
          <Field key={env.name} label={env.prompt || env.name} hint={env.required ? undefined : 'Optional'} value={values[env.name] ?? ''}
            onChangeText={(v) => setValues((x) => ({ ...x, [env.name]: v }))} secureTextEntry autoCapitalize="none" autoCorrect={false}
            placeholder={env.name} />
        ))}
        <Button title="Add server" loading={busy} disabled={busy || missing.length > 0} onPress={add} />
        {error ? <Text style={[s.note, { color: t.colors.danger, textAlign: 'center' }]}>{error}</Text> : null}
      </View>
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  error: { ...t.type.callout, color: t.colors.danger, marginTop: 10 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18, backgroundColor: t.colors.surface },
  bannerText: { ...t.type.callout, color: t.colors.text, flex: 1 },
  note: { ...t.type.caption, color: t.colors.textSecondary, marginTop: 8, paddingHorizontal: 4 },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 28 },
  emptyText: { ...t.type.callout, color: t.colors.textSecondary },
  description: { ...t.type.callout, color: t.colors.text },
  trust: { gap: 6, padding: 12, borderRadius: t.radius.md, backgroundColor: t.colors.surfaceSunken },
  trustLabel: { ...t.type.caption, color: t.colors.textSecondary },
  code: { ...t.type.footnote, fontFamily: t.fonts.mono, color: t.colors.text },
  result: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 12, borderRadius: t.radius.md },
  resultText: { ...t.type.caption, color: t.colors.text, flex: 1 },
}));
