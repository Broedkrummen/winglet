import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Sheet } from '../../components/Sheet';
import { ArrowDown, ChevronLeft, ChevronRight, Copy, Cpu, RefreshCw, Square } from '../../components/icons';
import { Button, IconButton, Tap } from '../../components/ui';
import { api, ApiError, signedApi } from '../../lib/api';
import { isOwner, useApp } from '../../lib/store';
import { makeStyles, useTheme } from '../../lib/themeContext';
import type { Server } from '../../lib/types';
import { applyOutput, EMPTY_OUTPUT, processLabel, type OutputPage, type OutputState, type ProcessRow, type StopState } from './model';

type Listing = { supported: boolean; processes: ProcessRow[]; truncated: boolean };
type Detail = { process: ProcessRow; output: OutputPage };

export function ProcessesSheet({ server, chatId, visible, onClose }: {
  server: Server; chatId: string; visible: boolean; onClose: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const online = useApp(st => st.network && st.runtime[server.id]?.status === 'online');
  const owner = useApp(st => isOwner(st.runtime[server.id]));
  const [listing, setListing] = useState<Listing | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [row, setRow] = useState<ProcessRow | null>(null);
  const [output, setOutput] = useState<OutputState>(EMPTY_OUTPUT);
  const outputRef = useRef(EMPTY_OUTPUT);
  const scroll = useRef<ScrollView>(null);
  const [follow, setFollow] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [copied, setCopied] = useState(false);
  const mounted = useRef(0);
  const mutation = useRef(0);
  const operation = useRef('');
  const base = `/api/processes/chats/${encodeURIComponent(chatId)}`;

  useEffect(() => {
    setSelected(null); setListing(null); setRow(null); setConfirm(false); setError('');
  }, [server.id, chatId, visible]);

  useEffect(() => {
    if (!owner) { setSelected(null); setListing(null); setRow(null); setOutput(EMPTY_OUTPUT); setError(''); }
  }, [owner]);

  useEffect(() => {
    outputRef.current = EMPTY_OUTPUT; setOutput(EMPTY_OUTPUT); setFollow(true); setCopied(false);
    setConfirm(false); setStopping(false); setStale(false); operation.current = '';
  }, [server.id, chatId, selected]);

  useEffect(() => {
    const sequence = ++mounted.current;
    if (!visible || !online || !owner) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    const poll = async () => {
      const started = mutation.current;
      let terminal = false;
      try {
        if (selected) {
          const cursor = outputRef.current.cursor;
          const detail = await api<Detail>(server, `${base}/${encodeURIComponent(selected)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
          if (disposed || started !== mutation.current) return;
          setRow(detail.process);
          outputRef.current = applyOutput(outputRef.current, detail.output);
          setOutput(outputRef.current);
        } else {
          const next = await api<Listing>(server, base);
          if (disposed) return;
          setListing(next);
        }
        setError('');
      } catch (e) {
        if (!disposed) {
          setError((e as Error).message);
          terminal = e instanceof ApiError && [403, 404, 409].includes(e.status);
          if (terminal) setStale(true);
        }
      } finally {
        if (!disposed) { setLoading(false); if (!terminal) timer = setTimeout(poll, 2000); }
      }
    };
    poll();
    return () => { disposed = true; clearTimeout(timer); if (mounted.current === sequence) mounted.current++; };
  }, [server, chatId, selected, visible, online, owner, refresh]);

  const stop = async () => {
    if (!selected || !online || stopping || !owner) return;
    const sequence = mounted.current;
    mutation.current++; // a read from before this action must not erase its newer stop state
    operation.current ||= `stop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    setStopping(true); setError('');
    try {
      const result = await signedApi<StopState>(server, 'POST', `${base}/${encodeURIComponent(selected)}/stop`, { operation_id: operation.current });
      if (sequence !== mounted.current) return;
      mutation.current++;
      setRow(current => current ? { ...current, stop: result } : current);
      setConfirm(false); setRefresh(x => x + 1);
    } catch (e) {
      if (sequence === mounted.current) setError((e as Error).message);
    } finally { if (sequence === mounted.current) setStopping(false); }
  };
  const back = () => { setSelected(null); setRow(null); setConfirm(false); setError(''); };
  const active = row?.stop?.status === 'stopping';
  const color = (item: ProcessRow) => item.status === 'running' ? t.colors.accent : item.exit_code ? t.colors.warning : t.colors.success;

  return <Sheet visible={visible} onClose={onClose} title={confirm ? 'Stop this process?' : selected ? 'Process output' : 'Background processes'}>
    <View style={{ height: Math.max(180, Math.min(560, height - insets.top - insets.bottom - 160)), gap: 12 }}>
      {!online ? <Text style={s.notice} accessibilityLiveRegion="polite">Connection lost. Reconnect to refresh output or stop a process.</Text> : null}
      {!owner ? <Text style={s.notice}>Only an owner can inspect or stop server processes.</Text> : null}
      {error ? <View style={s.errorBox}><Text style={s.error} accessibilityLiveRegion="polite">{error}</Text>
        <Button title="Reload list" size="sm" variant="secondary" onPress={() => { back(); setRefresh(x => x + 1); }} /></View> : null}
      {selected && row ? <>
        <View style={s.detailHead}>
          <IconButton label="Back to processes" onPress={back}><ChevronLeft size={20} color={t.colors.text} /></IconButton>
          <View style={s.flex}><Text style={s.command} numberOfLines={2}>{row.command || 'Background process'}</Text>
            <Text style={[s.state, { color: color(row) }]}>{processLabel(row)}</Text></View>
        </View>
        <View style={{ gap: 2 }}><Text style={s.meta} numberOfLines={1}>{row.workspace || 'Workspace not reported'}</Text>
          <Text style={s.meta}>Started {row.started_at ? new Date(row.started_at * 1000).toLocaleString() : 'time not reported'}</Text></View>
        {confirm ? <>
          <ScrollView style={s.flex} contentContainerStyle={{ gap: 14 }}>
            <Text style={s.body}>This ends the background job running in this chat. Any unsaved work in that process may be lost.</Text>
            <Text style={s.body}>Hermes stops the process using its server backend. Windows uses forceful tree termination; other backends may also force remaining processes to stop.</Text>
            <Text style={s.meta}>Closing this sheet does not cancel a Stop request that has already started.</Text>
          </ScrollView>
          <View style={s.actions}><Button title="Keep running" variant="secondary" style={s.flex} onPress={() => setConfirm(false)} />
            <Button title="Stop process" variant="danger" style={s.flex} disabled={!online || active || stale} loading={stopping} onPress={stop} /></View>
        </> : <>
          {row.stop ? <Text style={row.stop.status === 'failed' ? s.error : s.notice} accessibilityLiveRegion="polite">{row.stop.message}</Text> : null}
          {output.truncated ? <Text style={s.meta}>Showing a bounded tail. Earlier output was discarded.</Text> : null}
          {output.unavailable ? <Text style={s.meta}>Recovered after a restart. Earlier output is unavailable.</Text> : null}
          <ScrollView ref={scroll} style={s.output} contentContainerStyle={{ padding: 12 }}
            onContentSizeChange={() => { if (follow) scroll.current?.scrollToEnd({ animated: false }); }}
            onScrollBeginDrag={() => setFollow(false)} nestedScrollEnabled>
            <Text selectable style={s.outputText}>{output.text || (loading ? 'Loading output…' : 'No output yet.')}</Text>
          </ScrollView>
          <View style={s.actions}>
            <Button title={follow ? 'Pause follow' : 'Follow output'} size="sm" variant="secondary" style={s.flex}
              icon={<ArrowDown size={15} color={t.colors.text} />} onPress={() => { setFollow(x => !x); if (!follow) scroll.current?.scrollToEnd({ animated: false }); }} />
            <Button title={copied ? 'Copied' : 'Copy'} size="sm" variant="ghost" icon={<Copy size={15} color={t.colors.text} />}
              disabled={!output.text} onPress={async () => { try { await Clipboard.setStringAsync(output.text); setCopied(true); } catch { setError('Could not copy output.'); } }} />
          </View>
          {row.can_stop ? <Button title={active ? 'Waiting for stop…' : 'Stop process…'} variant="danger" disabled={!online || active || stale}
            icon={<Square size={15} color={t.colors.danger} />} onPress={() => { operation.current = ''; setConfirm(true); }} /> : null}
        </>}
      </> : <>
        <View style={s.detailHead}><Text style={[s.meta, s.flex]}>Only jobs started by this chat's current session are shown.</Text>
          <Button title="Refresh" size="sm" variant="ghost" disabled={!online} icon={<RefreshCw size={18} color={t.colors.text} />}
            onPress={() => setRefresh(x => x + 1)} /></View>
        {loading && !listing ? <ActivityIndicator style={{ margin: 24 }} color={t.colors.accent} /> : null}
        {listing?.supported === false ? <Text style={s.body}>This Hermes version can't report background processes. Update it on the server.</Text> : null}
        <ScrollView style={s.flex} contentContainerStyle={{ gap: 4 }}>
          {listing?.processes.map(item => <Tap key={item.handle} style={s.row} accessibilityLabel={`${item.command}. ${processLabel(item)}. Show output.`}
            onPress={() => { setRow(item); setSelected(item.handle); }}>
            <Cpu size={20} color={color(item)} /><View style={s.flex}>
              <Text style={s.command} numberOfLines={2}>{item.command || 'Background process'}</Text>
              <Text style={[s.state, { color: color(item) }]}>{processLabel(item)}</Text>
              <Text style={s.meta} numberOfLines={1}>{item.workspace || 'Workspace not reported'}</Text>
            </View><ChevronRight size={18} color={t.colors.textTertiary} />
          </Tap>)}
          {listing?.supported && listing.processes.length === 0 ? <View style={s.empty}><Cpu size={34} color={t.colors.textTertiary} />
            <Text style={s.emptyTitle}>No background processes</Text><Text style={s.meta}>Builds, watchers and servers started by this chat will appear here.</Text></View> : null}
          {listing?.truncated ? <Text style={s.meta}>Showing the newest 80 processes.</Text> : null}
        </ScrollView>
      </>}
    </View>
  </Sheet>;
}

const useStyles = makeStyles(t => ({
  flex: { flex: 1, minWidth: 0 },
  detailHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 88, paddingHorizontal: 8, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: t.colors.border },
  command: { ...t.type.callout, fontFamily: t.fonts.mono, color: t.colors.text },
  state: { ...t.type.caption, fontFamily: t.fonts.semibold, marginTop: 4 },
  meta: { ...t.type.caption, color: t.colors.textTertiary, lineHeight: 18 },
  body: { ...t.type.body, color: t.colors.textSecondary, lineHeight: 23 },
  notice: { ...t.type.caption, color: t.colors.textSecondary, lineHeight: 19 },
  errorBox: { gap: 6 },
  error: { ...t.type.caption, color: t.colors.danger, lineHeight: 19 },
  output: { flex: 1, minHeight: 80, borderRadius: t.radius.md, backgroundColor: t.colors.codeBg, borderWidth: 1, borderColor: t.colors.border },
  outputText: { fontFamily: t.fonts.mono, fontSize: 12, lineHeight: 19, color: t.colors.text, flexWrap: 'wrap' },
  empty: { alignItems: 'center', gap: 14, paddingVertical: 40, paddingHorizontal: 16 },
  emptyTitle: { ...t.type.heading, color: t.colors.text },
}));
