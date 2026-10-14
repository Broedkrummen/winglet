import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Check } from '../components/icons';
import { shortModel } from '../components/PickerCard';
import { Screen } from '../components/Screen';
import { Sheet } from '../components/Sheet';
import { Button, Card, ListGroup, ListRow, LoadError, SearchField, SectionHeader, Skeleton } from '../components/ui';
import { api, signedApi } from '../lib/api';
import { haptic } from '../lib/haptics';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';

type Options = { model: string; provider: string; providers: { slug: string; name: string; models: string[] }[] };
type Result = { ok: boolean; confirm_required?: boolean; confirm_message?: string; model?: string; provider?: string };

/** The model new chats start with. A chat can still switch on its own from the model chip. */
export default function ModelScreen() {
  const t = useTheme();
  const s = useStyles();
  const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
  const [options, setOptions] = useState<Options | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState<{ provider: string; model: string; message: string } | null>(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = () => {
    if (!server) return;
    return api<Options>(server, '/api/models').then((d) => { setOptions(d); setError(''); }).catch((e) => setError((e as Error).message));
  };
  useEffect(() => { load(); }, [server?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = async (provider: string, model: string, confirmed = false) => {
    if (!server) return;
    setBusy(`${provider}/${model}`);
    setError('');
    try {
      const result = await signedApi<Result>(server, 'PUT', '/api/models/default', { provider, model, ...(confirmed ? { confirm: true } : {}) });
      if (result.confirm_required) {
        setConfirm({ provider, model, message: result.confirm_message ?? '' });
      } else {
        haptic.success();
        setConfirm(null);
        load();
      }
    } catch (e) {
      // A toast, where you're looking: the screen's own error line is at the top of a long list.
      haptic.error();
      useApp.getState().toast({ serverId: server.id, title: "Couldn't change the model", body: (e as Error).message });
    } finally {
      setBusy('');
    }
  };

  const q = query.trim().toLowerCase();
  const providers = useMemo(() => (options?.providers ?? []).map((p) => ({
    ...p, models: q ? p.models.filter((m) => m.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) : p.models,
  })).filter((p) => p.models.length), [options, q]);

  return (
    <Screen title="Default model" subtitle="New chats start with this model. Each chat can switch on its own from the model button at the top."
      onRefresh={load}>
      {options ? (
        <Card style={s.current}>
          <Text style={s.label}>Now</Text>
          <Text style={s.currentModel}>{shortModel(options.model) || 'Not set'}</Text>
          <Text style={s.note}>{options.providers.find((p) => p.slug === options.provider)?.name ?? options.provider}</Text>
        </Card>
      ) : null}
      <SearchField value={query} onChangeText={setQuery} placeholder="Find a model" style={{ marginTop: 16 }} />
      {error && options ? <Text style={s.error}>{error}</Text> : null}
      {!options ? (error ? <LoadError message={error} onRetry={load} /> : (
        <View style={{ gap: 10, marginTop: 16 }}>{[0, 1, 2].map((i) => <Skeleton key={i} height={52} radius={16} />)}</View>
      )) : providers.length === 0 ? (
        <Card style={{ marginTop: 16, gap: 12 }}>
          <Text style={s.note}>{q ? `No model matches “${query}”.` : 'No providers are set up yet. Add one with its API key.'}</Text>
          {q ? null : <Button title="Add a provider" variant="tonal" size="sm" onPress={() => router.push('/providers')} />}
        </Card>
      ) : providers.map((p) => (
        <View key={p.slug}>
          <SectionHeader title={p.name} />
          <ListGroup>
            {p.models.slice(0, expanded.has(p.slug) ? undefined : q ? 60 : 30).map((m) => {
              const current = m === options.model && p.slug === options.provider;
              const key = `${p.slug}/${m}`;
              return (
                <ListRow key={key} title={shortModel(m)} subtitle={m !== shortModel(m) ? m : undefined} chevron={false}
                  right={busy === key ? <ActivityIndicator color={t.colors.accent} /> : current ? <Check size={18} color={t.colors.accent} /> : undefined}
                  onPress={current || busy ? undefined : () => set(p.slug, m)} />
              );
            })}
            {!expanded.has(p.slug) && p.models.length > (q ? 60 : 30) ? (
              <ListRow title={`Show all ${p.models.length}`} onPress={() => setExpanded((all) => new Set(all).add(p.slug))} />
            ) : null}
          </ListGroup>
        </View>
      ))}
      <Sheet visible={!!confirm} onClose={() => setConfirm(null)} title="Use an expensive model?">
        <View style={{ gap: 14, paddingHorizontal: 4 }}>
          <Text style={s.sheetText}>{confirm?.message}</Text>
          <Button title={`Use ${shortModel(confirm?.model ?? '')}`} variant="danger" loading={!!busy}
            onPress={() => confirm && set(confirm.provider, confirm.model, true)} />
          <Button title="Cancel" variant="secondary" onPress={() => setConfirm(null)} />
        </View>
      </Sheet>
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  current: { gap: 2, marginTop: 4 },
  label: { ...t.type.label, fontSize: 11.5, color: t.colors.textSecondary },
  currentModel: { ...t.type.title, color: t.colors.text },
  note: { ...t.type.callout, color: t.colors.textSecondary },
  error: { ...t.type.callout, color: t.colors.danger, marginTop: 10 },
  sheetText: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center' },
}));
