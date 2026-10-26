import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Screen } from '../components/Screen';
import { Sheet } from '../components/Sheet';
import { withSelectedServer } from '../components/ServerScreen';
import { Button, Card, ConfirmButton, Field, ListGroup, ListRow, LoadError, SearchField, SectionHeader, Skeleton, Toggle } from '../components/ui';
import { api, signedApi } from '../lib/api';
import { isOwner, useApp, useServerState } from '../lib/store';
import { makeStyles } from '../lib/themeContext';
import { draftKey, keepDraft, matchingFields, parseConfigValue, savedDraft, valueLabel,
  type Changes, type ConfigCatalog, type ConfigField, type ConfigPreview, type ConfigValue } from '../features/advanced-config/model';

export default withSelectedServer(AdvancedConfig);
function AdvancedConfig() {
  const s = useStyles();
  const server = useApp(st => st.servers.find(x => x.id === st.selection.serverId) ?? st.servers[0])!;
  const rt = useServerState(server.id);
  const network = useApp(st => st.network);
  const key = draftKey(server.id, server.profile);
  const previous = savedDraft(key);
  const [catalog, setCatalog] = useState<ConfigCatalog | null>(previous?.catalog ?? null);
  const [changes, setChanges] = useState<Changes>(previous?.changes ?? {});
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<ConfigField | null>(null);
  const [input, setInput] = useState('');
  const [preview, setPreview] = useState<ConfigPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  const live = network && rt?.status === 'online' && isOwner(rt);
  const count = Object.keys(changes).length;
  useEffect(() => { if (catalog) keepDraft(key, {catalog, changes}); }, [key, catalog, changes]);
  useEffect(() => () => { generation.current++; }, []);
  const load = async () => {
    if (!live || count) return;
    const ticket = ++generation.current;
    setError('');
    try { const data = await api<ConfigCatalog>(server, '/api/config/catalog'); if (ticket === generation.current) setCatalog(data); }
    catch (e) { if (ticket === generation.current) setError((e as Error).message); }
  };
  useEffect(() => { if (!catalog && !count) void load(); }, [live, !!catalog, count]); // retain fields/drafts on disconnect
  const edit = (field: ConfigField, value: ConfigValue | null) => {
    generation.current++;
    setPreview(null); setError(''); setMessage('');
    setChanges(old => {
      const next = {...old};
      if (value === field.value && field.source === 'override') delete next[field.key];
      else if (value === null && field.source === 'inherited') delete next[field.key];
      else next[field.key] = value;
      return next;
    });
  };
  const review = async () => {
    if (!catalog || !live || busy || !count) return;
    const ticket = ++generation.current;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await signedApi<ConfigPreview>(server, 'POST', '/api/config/preview', {revision: catalog.revision, changes});
      if (ticket === generation.current) setPreview(result);
    } catch(e) { if (ticket === generation.current) setError((e as Error).message); }
    finally { if (ticket === generation.current) setBusy(false); }
  };
  const apply = async () => {
    if (!preview || !catalog || !live || busy) return;
    const ticket = ++generation.current;
    setBusy(true); setError('');
    try {
      const result = await signedApi<ConfigCatalog>(server, 'POST', '/api/config/apply', {revision: preview.revision, changes});
      if (ticket === generation.current) {
        keepDraft(key); setChanges({}); setCatalog(result); setPreview(null);
        setMessage('Saved for this bot. Start a new chat for memory and file settings; context and turn limits apply next turn.');
      }
    } catch(e) { if (ticket === generation.current) { setPreview(null); setError((e as Error).message); } }
    finally { if (ticket === generation.current) setBusy(false); }
  };
  const discard = () => { generation.current++; keepDraft(key); setChanges({}); setPreview(null); setBusy(false); setError(''); };
  const visible = matchingFields(catalog?.fields ?? [], query);
  return <Screen title="Agent configuration" subtitle="Context, memory and execution. Review changes before saving to this bot." onRefresh={!count ? load : undefined}>
    {!isOwner(rt) ? <Text style={s.note}>Only an owner can manage these settings.</Text> : <>
      {!live ? <Text style={s.note}>Offline. Loaded settings and unsaved changes stay here; reconnect to review or save.</Text> : null}
      {error ? count ? <Text style={s.error} accessibilityLiveRegion="polite">{error}</Text> : <LoadError message={error} onRetry={load} /> : null}
      {!catalog ? <Skeleton height={260} /> : <>
        <SearchField value={query} onChangeText={setQuery} placeholder="Search agent settings" style={{marginTop: 16}} />
        {count ? <Card style={s.pending}>
          <Text style={s.title}>{count} unsaved {count === 1 ? 'change' : 'changes'}</Text>
          <Text style={s.note}>Kept while you navigate or switch bots in this app session.</Text>
          <Button title="Review changes" onPress={review} disabled={!live || busy} loading={busy} />
          <ConfirmButton title="Discard changes and reload" onConfirm={() => {discard(); setCatalog(null);}} />
        </Card> : null}
        {['Context', 'Memory', 'Execution'].map(section => {
          const fields = visible.filter(f => f.section === section);
          return fields.length ? <View key={section}><SectionHeader title={section} /><ListGroup>
            {fields.map(field => {
              const changed = Object.prototype.hasOwnProperty.call(changes, field.key);
              const value = changed ? changes[field.key] ?? field.default : field.value;
              return <ListRow key={field.key} title={field.label}
                subtitle={`${changed ? 'Unsaved · ' : ''}${field.source === 'managed' ? 'Managed by your server' : changed && changes[field.key] === null ? 'Reset to inherited' : field.source === 'override' ? 'Custom for this bot' : 'Inherited from Hermes'}`}
                value={valueLabel(value)} onPress={busy || !field.writable ? undefined : () => {setInput(value === null ? '' : String(value)); setEditing(field); setError('');}} />;
            })}
          </ListGroup></View> : null;
        })}
        {!visible.length ? <Text style={s.note}>No matching settings.</Text> : null}
      </>}
      {message ? <Text style={s.note} accessibilityLiveRegion="polite">{message}</Text> : null}
    </>}
    <Sheet visible={!!editing} title={editing?.label} onClose={() => setEditing(null)} scrollable>
      {editing ? <View style={s.sheet}>
        <Text style={s.note}>{editing.description}</Text>
        <Text style={s.note}>Hermes default: {valueLabel(editing.default)} · {editing.applies === 'new_session' ? 'Start a new chat after saving' : 'Applies next turn'}</Text>
        {editing.type === 'boolean' ? <Toggle label={editing.label} value={input === 'true'} onValueChange={v => setInput(String(v))} /> :
          <Field label={editing.label} value={input} onChangeText={setInput} keyboardType="decimal-pad"
            hint={`From ${editing.minimum} to ${editing.maximum}`} autoCorrect={false} />}
        <Button title="Keep change" onPress={() => { try { edit(editing, editing.type === 'boolean' ? input === 'true' : parseConfigValue(editing, input)); setEditing(null); } catch(e) {setError((e as Error).message);} }} />
        <Button title="Reset to inherited" variant="tonal" onPress={() => {edit(editing, null); setEditing(null);}} />
        {error ? <Text style={s.error} accessibilityLiveRegion="polite">{error}</Text> : null}
      </View> : null}
    </Sheet>
    <Sheet visible={!!preview} title="Review configuration" onClose={() => {if (!busy) setPreview(null);}} scrollable>
      <View style={s.sheet}>
        {preview?.changes.map(change => <View key={change.key} style={s.change}>
          <Text style={s.title}>{change.label}</Text>
          <Text style={s.note}>{valueLabel(change.before)} → {valueLabel(change.after)}{change.reset ? ' · Inherited' : ''} · {change.applies === 'new_session' ? 'New chats' : 'Next turn'}</Text>
        </View>)}
        <Text style={s.note}>Only this bot changes. Existing turns continue; the server will not restart.</Text>
        <Button title="Apply reviewed changes" onPress={apply} loading={busy} disabled={!live || busy} />
      </View>
    </Sheet>
  </Screen>;
}
const useStyles = makeStyles(t => ({
  note: {...t.type.callout, color: t.colors.textSecondary, marginVertical: 8},
  title: {...t.type.callout, color: t.colors.text, fontFamily: t.fonts.semibold},
  error: {...t.type.callout, color: t.colors.danger},
  sheet: {paddingHorizontal: 8, gap: 14},
  pending: {marginTop: 14, gap: 8, borderColor: t.colors.accent},
  change: {paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: t.colors.border},
}));

