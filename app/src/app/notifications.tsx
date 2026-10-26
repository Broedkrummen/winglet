import { EncryptedPushSettings } from '../features/encrypted-push/Settings';
import { pushNative } from '../features/encrypted-push/native';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { AgentFace } from '../components/AgentFace';
import { BellOff, BellRing, Copy, Moon } from '../components/icons';
import { Screen } from '../components/Screen';
import { Sheet } from '../components/Sheet';
import { Button, Card, Chip, ListGroup, ListRow, SectionHeader, Toggle } from '../components/ui';
import { describeTestPush, enableNtfy, enableWebPush, openNtfySubscribe, sendTestPush, webPushServer, webPushState, type PushState } from '../lib/push';
import { pushPrefsKey, quietHours, usePushPrefs } from '../lib/pushPrefs';
import { homeChat, useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Server } from '../lib/types';

/** Turn on notifications: Web Push in the web app, the free ntfy app on Android. */
export default function NotificationsScreen() {
  const allServers = useApp((st) => st.servers);
  // A device has one subscription and one set of quiet hours per Hermes server.
  const servers = allServers.filter((server) => !server.parent);
  return (
    <Screen title="Notifications" subtitle="Get a nudge when a bot needs an approval, asks a question, or finishes something. Tapping a notification opens exactly that item.">
      {Platform.OS === 'web' ? <WebPushSettings servers={servers} /> : servers.map((srv) => pushNative ? <EncryptedPushSettings key={srv.id} server={srv} /> : <NtfySettings key={srv.id} server={srv} />)}
      {(Platform.OS === 'web' ? [webPushServer(servers)].filter((x): x is Server => !!x) : servers).map((srv) => (
        <QuietSettings key={srv.id} server={srv} named={servers.length > 1} />
      ))}
    </Screen>
  );
}

const TIMES = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

function clock(hhmm: string) {
  const d = new Date();
  d.setHours(Number(hhmm.slice(0, 2)), Number(hhmm.slice(3)), 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Quiet hours and muted chats for this device. Kept on the server, so they hold while the app is closed. */
function QuietSettings({ server, named }: { server: Server; named: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const supported = useApp((st) => !!st.runtime[server.id]?.info?.features?.mute);
  const chats = useApp((st) => st.runtime[server.id]?.chats);
  const prefs = usePushPrefs((st) => st.byServer[pushPrefsKey(server)]);
  const [editing, setEditing] = useState<'start' | 'end' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (supported) usePushPrefs.getState().load(server);
  }, [supported, server]);

  if (!supported) return null;
  const quiet = prefs?.quiet;
  const save = (change: Parameters<ReturnType<typeof usePushPrefs.getState>['save']>[1]) => {
    setError('');
    usePushPrefs.getState().save(server, change).catch((e) => setError((e as Error).message));
  };
  const muted = Object.entries(prefs?.muted ?? {}).filter(([, until]) => until === 0 || until > Date.now() / 1000);
  const chatName = (id: string) => id === '*' ? 'Everything' : id === homeChat(useApp.getState().runtime[server.id]) ? server.bot.title : chats?.[id]?.kind === 'home' ? 'Updates' : `#${chats?.[id]?.title ?? id}`;

  return (
    <>
      <SectionHeader title={named ? `Quiet hours · ${server.bot.title}` : 'Quiet hours'} />
      <ListGroup>
        <ListRow icon={<Moon size={18} color={t.colors.onAccentSoft} />} title="Quiet hours" subtitle={quiet ? `${clock(quiet.start)} to ${clock(quiet.end)}` : 'Off'}
          right={<Toggle label="Quiet hours" value={!!quiet} onValueChange={(on) => save((p) => ({ ...p, quiet: on ? quietHours('22:00', '07:00', true) : undefined }))} />} />
        {quiet ? (
          <>
            <ListRow title="Starts" value={clock(quiet.start)} onPress={() => setEditing('start')} />
            <ListRow title="Ends" value={clock(quiet.end)} onPress={() => setEditing('end')} />
            <ListRow title="Let approvals and questions through" subtitle={`${server.bot.title} is stuck until you answer those.`}
              right={<Toggle label="Let approvals and questions through" value={quiet.allow_urgent}
                onValueChange={(v) => save((p) => ({ ...p, quiet: p.quiet && { ...p.quiet, allow_urgent: v } }))} />} />
          </>
        ) : null}
      </ListGroup>
      {muted.length ? (
        <>
          <SectionHeader title="Muted" />
          <ListGroup>
            {muted.map(([id, until]) => (
              <ListRow key={id} icon={<BellOff size={18} color={t.colors.onAccentSoft} />} title={chatName(id)}
                subtitle={until ? `Until ${new Date(until * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Until you turn it back on'}
                right={<Button title="Unmute" size="sm" variant="tonal" onPress={() => save((p) => {
                  const next = { ...p.muted };
                  delete next[id];
                  return { ...p, muted: next };
                })} />} />
            ))}
          </ListGroup>
        </>
      ) : null}
      {error ? <Text style={[s.note, { color: t.colors.danger, marginTop: 8 }]} accessibilityLiveRegion="polite">{error}</Text> : null}
      <Sheet visible={!!editing} onClose={() => setEditing(null)} title={editing === 'start' ? 'Quiet from' : 'Quiet until'}>
        <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={s.times}>
          {TIMES.map((time) => (
            <Chip key={time} label={clock(time)} selected={quiet?.[editing ?? 'start'] === time} onPress={() => {
              const which = editing;
              setEditing(null);
              if (which) save((p) => ({ ...p, quiet: p.quiet && { ...p.quiet, [which]: time } }));
            }} />
          ))}
        </ScrollView>
      </Sheet>
    </>
  );
}

function WebPushSettings({ servers }: { servers: Server[] }) {
  const t = useTheme();
  const s = useStyles();
  const server = webPushServer(servers);
  const [state, setState] = useState<PushState>(webPushState());
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  let body: React.ReactNode;
  if (!server) body = <Text style={s.note}>Open Winglet from your Hermes server's address to turn on notifications here.</Text>;
  else if (state === 'insecure') body = <Text style={s.note}>Browsers only allow notifications over HTTPS. Open Winglet from your server's HTTPS address.</Text>;
  else if (state === 'needs-install') body = <Text style={s.note}>On iPhone, add Winglet to your Home Screen first (Share → Add to Home Screen), then open it from there.</Text>;
  else if (state === 'unsupported') body = <Text style={s.note}>This browser doesn't support push notifications.</Text>;
  else if (state === 'denied') body = <Text style={s.note}>Notifications are blocked for this site. Allow them in your browser or system settings, then come back.</Text>;
  else {
    body = (
      <>
        <Text style={s.note}>
          {state === 'granted' ? `You'll be notified when ${server.bot.title} needs you, even when Winglet is closed.`
            : `Get a notification when ${server.bot.title} needs an approval, asks a question, or finishes something.`}
        </Text>
        <View style={s.buttons}>
          <Button title={state === 'granted' ? 'Re-register this device' : 'Turn on notifications'} icon={<BellRing size={17} color={t.colors.onAccent} />}
            loading={busy} onPress={async () => {
              setBusy(true);
              try { setState(await enableWebPush(server)); setMsg(''); } catch (e) { setMsg((e as Error).message); }
              setBusy(false);
            }} />
          {state === 'granted' ? (
            <Button title="Send a test" variant="secondary" onPress={async () => {
              try { setMsg(describeTestPush(await sendTestPush(server))); } catch (e) { setMsg((e as Error).message); }
            }} />
          ) : null}
        </View>
      </>
    );
  }
  return (
    <>
      <SectionHeader title="This device" />
      <Card style={{ gap: 14 }}>
        {body}
        {msg ? <Text style={[s.note, { color: t.colors.text }]} accessibilityLiveRegion="polite">{msg}</Text> : null}
      </Card>
    </>
  );
}

function NtfySettings({ server }: { server: Server }) {
  const t = useTheme();
  const s = useStyles();
  const [topic, setTopic] = useState<{ server: string; topic: string } | null>(null);
  const [error, setError] = useState('');
  return (
    <>
      <SectionHeader title={server.bot.title} />
      <Card style={{ gap: 14 }}>
        <View style={s.botRow}>
          <AgentFace server={server} size={36} still />
          <Text style={[s.note, { flex: 1 }]}>
            This build uses generic ntfy notifications. The relay can see bot names and timing; message details stay on your server. Install the current Android build to set up encrypted delivery in Winglet.
          </Text>
        </View>
        {topic ? (
          <>
            <Text style={s.note}>Subscribe to this topic in ntfy (server {topic.server}):</Text>
            <Text selectable style={s.topic}>{topic.topic}</Text>
            <View style={s.buttons}>
              <Button title="Open in ntfy" onPress={() => openNtfySubscribe(topic.server, topic.topic)} />
              <Button title="Copy topic" variant="secondary" icon={<Copy size={16} color={t.colors.text} />} onPress={() => Clipboard.setStringAsync(topic.topic)} />
            </View>
          </>
        ) : (
          <Button title="Set up notifications" icon={<BellRing size={17} color={t.colors.onAccent} />} onPress={async () => {
            try { setTopic(await enableNtfy(server)); } catch (e) { setError((e as Error).message); }
          }} />
        )}
        {error ? <Text style={[s.note, { color: t.colors.danger }]}>{error}</Text> : null}
      </Card>
    </>
  );
}

const useStyles = makeStyles((t) => ({
  note: { ...t.type.callout, color: t.colors.textSecondary },
  buttons: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  botRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  times: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center', paddingBottom: 8 },
  topic: { fontFamily: t.fonts.mono, fontSize: 15, color: t.colors.text, backgroundColor: t.colors.surfaceSunken, padding: 12, borderRadius: t.radius.md },
}));
