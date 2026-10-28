import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Plug, ShieldAlert, TriangleAlert } from '../components/icons';
import { CustomAbility } from '../features/abilities/CustomAbility';
import { Screen } from '../components/Screen';
import { withSelectedServer } from '../components/ServerScreen';
import { Sheet } from '../components/Sheet';
import { Button, Card, Footnote, ListGroup, ListRow, LoadError, SectionHeader, Segmented, Skeleton, Toggle } from '../components/ui';
import { api, signedApi } from '../lib/api';
import { haptic } from '../lib/haptics';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { ApprovalMode, MemberTools, ToolsInfo } from '../lib/types';

const MODES: { value: ApprovalMode; label: string; about: string }[] = [
  { value: 'manual', label: 'Ask me', about: 'It asks before it runs anything risky, like deleting files or installing software.' },
  { value: 'smart', label: 'Smart', about: 'A second model approves commands it judges low-risk and asks you about the rest.' },
  { value: 'off', label: 'Never ask', about: 'It runs every command without asking. Only for a machine you can afford to lose.' },
];

/** What the agent can use when it works through Winglet, how risky commands get approved, and what members get. */
export default withSelectedServer(ToolsScreen);

function ToolsScreen() {
  const t = useTheme();
  const s = useStyles();
  const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
  const [info, setInfo] = useState<ToolsInfo | null>(null);
  const [error, setError] = useState('');
  const [confirmOff, setConfirmOff] = useState(false);

  const load = useCallback(() => {
    if (!server) return;
    return api<ToolsInfo>(server, '/api/toolsets').then((d) => { setInfo(d); setError(''); }).catch((e) => setError((e as Error).message));
  }, [server]);
  useEffect(() => { load(); }, [load]);
  if (!server) return null;

  const fail = (e: unknown) => {
    haptic.error();
    useApp.getState().toast({ serverId: server.id, title: "Couldn't change that", body: (e as Error).message });
    load();
  };
  const toggle = async (name: string, enabled: boolean) => {
    setInfo((x) => x && { ...x, toolsets: x.toolsets.map((ts) => (ts.name === name ? { ...ts, enabled } : ts)) });
    try { await signedApi(server, 'PUT', `/api/toolsets/${encodeURIComponent(name)}`, { enabled }); } catch (e) { fail(e); }
  };
  const setMode = async (mode: ApprovalMode) => {
    if (mode === 'off' && !confirmOff) { setConfirmOff(true); return; }
    setConfirmOff(false);
    setInfo((x) => x && { ...x, approvals: mode });
    try { await signedApi(server, 'PUT', '/api/approvals', { mode }); haptic.success(); } catch (e) { fail(e); }
  };
  const setMembers = async (members: MemberTools) => {
    setInfo((x) => x && { ...x, members });
    try { await signedApi(server, 'PUT', '/api/members/tools', members); } catch (e) { fail(e); }
  };

  const mode = MODES.find((m) => m.value === info?.approvals) ?? MODES[0];
  const mine = (info?.toolsets ?? []).filter((ts) => ts.enabled);
  return (
    <Screen title="Tools"
      onRefresh={load}>
      <CustomAbility server={server} type="tool" onDone={load} />
      {error && info ? <Text style={s.error}>{error}</Text> : null}
      {!info ? (error ? <LoadError message={error} onRetry={load} /> : (
        <View style={{ gap: 12, marginTop: 20 }}>{[0, 1, 2].map((i) => <Skeleton key={i} height={72} radius={16} />)}</View>
      )) : (
        <Animated.View entering={FadeIn}>
          <SectionHeader title="Approvals" />
          <Card style={s.card}>
            <Segmented label="Approvals" value={info.approvals} onChange={setMode} options={MODES.map(({ value, label }) => ({ value, label }))} />
            <View style={s.about}>
              {info.approvals === 'off' ? <TriangleAlert size={16} color={t.colors.danger} /> : <ShieldAlert size={16} color={t.colors.textSecondary} />}
              <Text style={[s.aboutText, info.approvals === 'off' && { color: t.colors.danger }]}>{mode.about}</Text>
            </View>
          </Card>

          <SectionHeader title="Toolsets" />
          <ListGroup>
            {info.toolsets.map((ts) => (
              <ListRow key={ts.name} title={ts.label}
                subtitle={ts.configured ? undefined : 'Needs setup on the server'}
                right={<Toggle label={ts.label} value={ts.enabled} onValueChange={(on) => toggle(ts.name, on)} />} />
            ))}
          </ListGroup>
          <Footnote>Changes apply next message, in Winglet only.</Footnote>

          {server.parent ? null : (<>
          <SectionHeader title="Members" />
          <Card style={s.card}>
            {info.members.can_limit === false && !info.members.limited ? null : (
              <Segmented label="Members' tools" value={info.members.limited ? 'limited' : 'same'}
                onChange={(v) => setMembers({ ...info.members, limited: v === 'limited' })}
                options={[{ value: 'same', label: 'Same as you' }, { value: 'limited', label: 'Limited' }]} />
            )}
            <Text style={[s.aboutText, info.members.limited && info.members.can_limit === false && { color: t.colors.danger }]}>
              {info.members.can_limit === false
                ? info.members.limited
                  ? "This Hermes can't apply the limit any more, so members' messages are held. Update Hermes, or choose Same as you."
                  : 'People you add as members can use every tool you can. Update Hermes to limit what they use.'
                : info.members.limited
                  ? 'Members only get the tools you pick here, and only while they are on for you too.'
                  : 'People you add as members can use every tool you can. Risky commands still wait for an owner.'}
            </Text>
          </Card>
          {info.members.limited && info.members.can_limit !== false ? (
            <ListGroup style={{ marginTop: 12 }}>
              {mine.map((ts) => {
                const on = info.members.toolsets.includes(ts.name);
                return (
                  <ListRow key={ts.name} title={ts.label} right={<Toggle label={`${ts.label} for members`} value={on} onValueChange={(v) =>
                    setMembers({ ...info.members, toolsets: v ? [...info.members.toolsets, ts.name] : info.members.toolsets.filter((n) => n !== ts.name) })} />} />
                );
              })}
              <ListRow icon={<Plug size={18} color={t.colors.textSecondary} />} title="MCP servers"
                right={<Toggle label="MCP servers for members" value={info.members.mcp} onValueChange={(mcp) => setMembers({ ...info.members, mcp })} />} />
            </ListGroup>
          ) : null}
          </>)}
        </Animated.View>
      )}

      <Sheet visible={confirmOff} onClose={() => setConfirmOff(false)} title="Stop asking for approval?">
        <View style={{ gap: 14, paddingHorizontal: 4 }}>
          <View style={s.warn}>
            <TriangleAlert size={20} color={t.colors.danger} />
            <Text style={[s.aboutText, { color: t.colors.text, flex: 1 }]}>
              Your agent will run any command without asking, including ones that delete files, change the system or spend money.
              A confusing message or a page it reads could lead it to do real damage.
            </Text>
          </View>
          <Button title="Never ask" variant="danger" onPress={() => setMode('off')} />
          <Button title="Keep asking" variant="secondary" onPress={() => setConfirmOff(false)} />
        </View>
      </Sheet>
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  error: { ...t.type.callout, color: t.colors.danger, marginTop: 10 },
  card: { gap: t.space.md },
  about: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  aboutText: { ...t.type.caption, color: t.colors.textSecondary, flex: 1 },
  warn: { flexDirection: 'row', gap: 10, padding: 14, borderRadius: t.radius.md, backgroundColor: t.colors.dangerSoft },
}));
