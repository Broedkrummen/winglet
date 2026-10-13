import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, Share as SystemShare, Text, View } from 'react-native';
import { BotAvatar } from '../components/BotAvatar';
import { Activity, Copy, KeyRound, Monitor, QrCode as QrIcon, RefreshCw, ShieldCheck, Smartphone, Trash2, UserPlus } from '../components/icons';
import { QrCode } from '../components/QrCode';
import { Screen } from '../components/Screen';
import { Sheet, SheetAction } from '../components/Sheet';
import { Button, Card, Field, ListGroup, ListRow, LoadError, SectionHeader, Segmented, Skeleton } from '../components/ui';
import { agoText } from '../lib/agent';
import { api, ApiError, parsePairLink, signedApi, verifyDevice } from '../lib/api';
import { haptic } from '../lib/haptics';
import { isOwner, useApp, useServerState } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Device, Role, Server } from '../lib/types';

/** Who can use this bot: this phone's role and verification, every paired device, and adding one. */
export default function DevicesScreen() {
  const servers = useApp((st) => st.servers);
  const selection = useApp((st) => st.selection);
  const server = servers.find((x) => x.id === selection.serverId) ?? servers[0];
  if (!server) return <Screen title="Devices"><Text>No bots paired yet.</Text></Screen>;
  return <Devices server={server} />;
}

function Devices({ server }: { server: Server }) {
  const t = useTheme();
  const s = useStyles();
  const rt = useServerState(server.id);
  const me = rt?.me;
  const owner = isOwner(rt);
  const roles = !!rt?.info?.features?.roles;
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [selected, setSelected] = useState<Device | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!owner || !roles) return;
    try {
      setDevices((await api<{ devices: Device[] }>(server, '/api/devices')).devices);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [server, owner, roles]);

  useEffect(() => { load(); }, [load, rt?.status]);

  if (!roles) {
    return (
      <Screen title="Devices" subtitle={`${server.bot.title}'s server needs a Winglet update for devices and roles.`}>
        <Card><Text style={s.note}>Run `hermes plugins update winglet` on the server, then restart the gateway.</Text></Card>
      </Screen>
    );
  }

  return (
    <Screen title="Devices" subtitle={owner ? `Phones and browsers that can talk to ${server.bot.title}, and what each may do.`
      : `This phone is a member: it chats with ${server.bot.title} in its own chats.`} onRefresh={owner ? load : undefined}>
      <ThisPhone server={server} />

      {owner ? (
        <>
          <SectionHeader title="Paired" right={me?.verified ? (
            <Button size="sm" variant="tonal" title="Add a device" icon={<UserPlus size={15} color={t.colors.onAccentSoft} />} onPress={() => setAdding(true)} />
          ) : null} />
          {devices === null ? (error ? <LoadError message={error} onRetry={load} /> : (
            <View style={{ gap: 10 }}>{[0, 1].map((i) => <Skeleton key={i} height={64} radius={18} />)}</View>
          )) : (
            <ListGroup>
              {devices.map((d) => (
                <ListRow key={d.id}
                  icon={d.platform === 'web' ? <Monitor size={18} color={t.colors.onAccentSoft} /> : <Smartphone size={18} color={t.colors.onAccentSoft} />}
                  title={d.current ? `${d.name} (this one)` : d.name}
                  subtitle={`${d.role === 'owner' ? 'Owner' : 'Member'} · ${d.verified ? 'verified' : 'not verified'} · seen ${agoText(d.last_seen)}`}
                  onPress={() => setSelected(d)} />
              ))}
            </ListGroup>
          )}
          {error && devices ? <Text style={[s.note, { color: t.colors.danger, marginTop: 8 }]}>{error}</Text> : null}
          <SectionHeader title="History" />
          <ListGroup>
            <ListRow icon={<Activity size={18} color={t.colors.onAccentSoft} />} title="Activity"
              subtitle="Pairings, role changes, approvals and refused requests" onPress={() => router.push('/activity')} />
          </ListGroup>
        </>
      ) : null}

      <DeviceSheet server={server} device={selected} canEdit={!!me?.verified} onClose={() => setSelected(null)} onChanged={load} />
      <AddDeviceSheet server={server} visible={adding} onClose={() => { setAdding(false); load(); }} />
    </Screen>
  );
}

/** This phone: its role, whether it can sign owner actions, and how to verify it if not. */
function ThisPhone({ server }: { server: Server }) {
  const t = useTheme();
  const s = useStyles();
  const me = useApp((st) => st.runtime[server.id]?.me);
  const updateServer = useApp((st) => st.updateServer);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const verify = async () => {
    const parsed = parsePairLink(link);
    if (!parsed?.fp) {
      setMessage('Paste the whole link from `hermes winglet pair` (it ends with &fp=…).');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const verified = await verifyDevice(server, parsed.code, parsed.fp);
      await updateServer(server.id, { fingerprint: verified.fingerprint }, true);
      haptic.success();
      setLink('');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    setBusy(true);
    try {
      const { token } = await signedApi<{ token: string }>(server, 'POST', '/api/devices/me/rotate-token', {});
      await updateServer(server.id, { token }, true);
      haptic.success();
      setMessage('This phone has a new access token. The old one no longer works.');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionHeader title="This device" />
      <Card style={{ gap: 14 }}>
        <View style={s.meRow}>
          <BotAvatar name={server.bot.name} size={40} />
          <View style={{ flex: 1 }}>
            <Text style={s.meName}>{me?.name ?? 'This phone'}</Text>
            <Text style={s.note}>{me?.role === 'member' ? 'Member' : 'Owner'} of {server.bot.title}</Text>
          </View>
          <View style={[s.badge, { backgroundColor: me?.verified ? t.colors.successSoft : t.colors.warningSoft }]}>
            {me?.verified ? <ShieldCheck size={14} color={t.colors.success} /> : <KeyRound size={14} color={t.colors.warning} />}
            <Text style={[s.badgeText, { color: me?.verified ? t.colors.success : t.colors.warning }]}>{me?.verified ? 'Verified' : 'Not verified'}</Text>
          </View>
        </View>
        {me?.verified ? (
          <>
            <Text style={s.note}>Owner actions from this phone are signed with a key that never leaves it, so a copied token alone can't make changes.</Text>
            <Button title="Replace access token" variant="secondary" size="sm" icon={<RefreshCw size={15} color={t.colors.text} />} loading={busy} onPress={rotate} />
          </>
        ) : (
          <>
            <Text style={s.note}>
              This phone was paired without checking the server's key, so it can chat but can't make changes. To verify it, run
              `hermes winglet pair` on the server (or use Add a device on a verified phone) and scan the code{Platform.OS === 'web' ? ', or paste the link here' : ''}.
            </Text>
            {Platform.OS !== 'web' ? (
              <Button title="Scan a code" icon={<QrIcon size={17} color={t.colors.onAccent} />} onPress={() => router.push('/scan')} />
            ) : null}
            <Field value={link} onChangeText={setLink} placeholder="https://…/#pair=…&fp=…" autoCapitalize="none" autoCorrect={false} />
            <Button title="Verify" variant={Platform.OS === 'web' ? 'primary' : 'secondary'} loading={busy} disabled={!link.trim()} onPress={verify} />
          </>
        )}
        {message ? <Text style={[s.note, { color: t.colors.text }]} accessibilityLiveRegion="polite">{message}</Text> : null}
      </Card>
    </>
  );
}

function DeviceSheet({ server, device, canEdit, onClose, onChanged }: {
  server: Server; device: Device | null; canEdit: boolean; onClose: () => void; onChanged: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const [mode, setMode] = useState<'menu' | 'rename' | 'role' | 'remove'>('menu');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shown, setShown] = useState<Device | null>(device);
  if (device && device !== shown) setShown(device);
  const d = device ?? shown;
  const close = () => { setMode('menu'); setError(''); onClose(); };
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      haptic.success();
      onChanged();
      close();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!d) return null;
  const path = `/api/devices/${d.id}`;
  return (
    <Sheet visible={!!device} onClose={close} title={d.name}>
      {!canEdit ? (
        <Text style={s.sheetNote}>Verify this phone to rename, change or remove devices.</Text>
      ) : mode === 'menu' ? (
        <>
          <Text style={s.sheetNote}>{d.role === 'owner' ? 'Owner' : 'Member'} · {d.platform || 'unknown'} · paired {agoText(d.created_at)}</Text>
          <SheetAction label="Rename" onPress={() => { setName(d.name); setMode('rename'); }} />
          <SheetAction label={d.role === 'owner' ? 'Make a member' : 'Make an owner'} onPress={() => setMode('role')} />
          <SheetAction icon={<Trash2 size={20} color={t.colors.danger} />} label={d.current ? 'Remove this phone' : 'Remove'} destructive onPress={() => setMode('remove')} />
        </>
      ) : mode === 'role' ? (
        <View style={{ gap: 14, paddingHorizontal: 4 }}>
          <Text style={s.sheetNote}>
            {d.role === 'owner'
              ? `${d.current ? 'This phone' : d.name} will chat in its own chats only, and can't approve commands, see other chats or change settings.${d.current ? " You'll need another owner to undo it." : ''}`
              : `${d.name} will see every chat, approve commands and change ${server.bot.title}'s settings.`}
          </Text>
          <Button title={d.role === 'owner' ? 'Make a member' : 'Make an owner'} variant={d.role === 'owner' ? 'danger' : 'primary'} loading={busy}
            onPress={() => run(() => signedApi(server, 'PATCH', path, { role: d.role === 'owner' ? 'member' : 'owner' }))} />
          <Button title="Cancel" variant="secondary" onPress={() => setMode('menu')} />
        </View>
      ) : mode === 'rename' ? (
        <View style={{ gap: 14, paddingHorizontal: 4 }}>
          <Field value={name} onChangeText={setName} placeholder="Device name" autoFocus />
          <Button title="Save" loading={busy} onPress={() => run(() => signedApi(server, 'PATCH', path, { name }))} />
        </View>
      ) : (
        <View style={{ gap: 14, paddingHorizontal: 4 }}>
          <Text style={s.sheetNote}>{d.name} will be signed out at once and can't reconnect without a new pairing code.</Text>
          <Button title="Remove" variant="danger" loading={busy} onPress={() => run(() => signedApi(server, 'DELETE', path))} />
          <Button title="Cancel" variant="secondary" onPress={() => setMode('menu')} />
        </View>
      )}
      {error ? <Text style={[s.sheetNote, { color: t.colors.danger }]}>{error}</Text> : null}
    </Sheet>
  );
}

/** Mint a single-use code and show it as a QR for the other phone to scan. */
function AddDeviceSheet({ server, visible, onClose }: { server: Server; visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const s = useStyles();
  const [role, setRole] = useState<Role>('member');
  const [code, setCode] = useState<{ code: string; fingerprint: string; expires_at: number; role: Role } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!code) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [code]);

  const close = () => { setCode(null); setError(''); onClose(); };
  const create = async () => {
    setBusy(true);
    setError('');
    try {
      setCode(await signedApi(server, 'POST', '/api/devices/pairing-code', { role }));
      haptic.success();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const link = code ? `${server.url}/#pair=${code.code}&fp=${code.fingerprint}` : '';
  const left = code ? Math.max(0, Math.round(code.expires_at - now / 1000)) : 0;

  return (
    <Sheet visible={visible} onClose={close} title={code ? `Scan to pair as ${code.role === 'owner' ? 'an owner' : 'a member'}` : 'Add a device'}>
      {code ? (
        <View style={s.qrWrap}>
          <View style={s.qrFrame}><QrCode value={link} size={220} label="Pairing code" /></View>
          <Text style={s.code} selectable>{code.code.slice(0, 4)}-{code.code.slice(4)}</Text>
          <Text style={s.sheetNote}>
            {left > 0 ? `Works once, for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} more.` : 'This code has expired.'}
            {' '}On an iPhone, scan it with the Camera app; on Android, with Winglet.
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button size="sm" variant="secondary" title="Copy link" icon={<Copy size={15} color={t.colors.text} />} onPress={() => Clipboard.setStringAsync(link)} />
            {Platform.OS !== 'web' ? <Button size="sm" variant="secondary" title="Share" onPress={() => SystemShare.share({ message: link })} /> : null}
            {left === 0 ? <Button size="sm" title="New code" onPress={create} loading={busy} /> : null}
          </View>
        </View>
      ) : (
        <View style={{ gap: 14, paddingHorizontal: 4 }}>
          <Segmented label="Role" value={role} onChange={setRole}
            options={[{ value: 'member', label: 'Member' }, { value: 'owner', label: 'Owner' }]} />
          <Text style={s.sheetNote}>
            {role === 'member'
              ? `A member chats with ${server.bot.title} in their own chats. They can't approve commands, see your chats, or change settings. ${server.bot.title}'s memory and tools are shared, so only add people you'd trust with your agent.`
              : `An owner can do everything you can: approve commands, see every chat, and manage devices.`}
          </Text>
          <Button title="Show pairing code" loading={busy} onPress={create} />
        </View>
      )}
      {error ? <Text style={[s.sheetNote, { color: t.colors.danger }]}>{error}</Text> : null}
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  note: { ...t.type.callout, color: t.colors.textSecondary },
  meRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  meName: { ...t.type.bodyStrong, color: t.colors.text },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: t.radius.pill },
  badgeText: { fontFamily: t.fonts.semibold, fontSize: 12.5 },
  sheetNote: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center', paddingHorizontal: 12, marginBottom: 6 },
  qrWrap: { alignItems: 'center', gap: 12, paddingBottom: 4 },
  qrFrame: { padding: 12, borderRadius: t.radius.lg, backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border },
  code: { fontFamily: t.fonts.mono, fontSize: 22, letterSpacing: 2, color: t.colors.text },
}));
