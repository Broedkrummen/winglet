import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { InstallButton } from '../components/AppUpdate';
import { AgentFace } from '../components/AgentFace';
import { Activity, CircleArrowUp, ExternalLink, FileText, HardDrive, RefreshCw } from '../components/icons';
import { Logo } from '../components/Logo';
import { Screen } from '../components/Screen';
import { Button, Card, Footnote, ListGroup, ListRow, SectionHeader, Toggle } from '../components/ui';
import { agoText } from '../lib/agent';
import { appUpdateSupported, useAppUpdate } from '../lib/appUpdateCheck';
import { usePrefs } from '../lib/prefs';
import { APP_PROTOCOL, useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import { compareVersions } from '../lib/version';

/** Versions on both sides, what to update, and the on-device cache. */
export default function AboutScreen() {
  const t = useTheme();
  const s = useStyles();
  const servers = useApp((st) => st.servers);
  const runtime = useApp((st) => st.runtime);
  const clearCache = useApp((st) => st.clearCache);
  const [cleared, setCleared] = useState(false);
  const appVersion = Constants.expoConfig?.version ?? '';
  return (
    <Screen title="About">
      <View style={s.hero}>
        <Logo size={76} />
        <Text style={s.app}>Winglet</Text>
        <View style={s.pills}>
          {appVersion ? <View style={s.pill}><Text style={s.pillText}>Version {appVersion}</Text></View> : null}
          <View style={s.pill}><Text style={s.pillText}>Open source</Text></View>
        </View>
      </View>
      <Footnote>Not affiliated with Nous Research.</Footnote>

      <SectionHeader title="Your bots" />
      <View style={{ gap: 10 }}>
        {servers.map((srv) => {
          const info = runtime[srv.id]?.info;
          const compat = runtime[srv.id]?.compat;
          const behind = !!info?.version && !!appVersion && compareVersions(info.version, appVersion) < 0;
          return (
            <Card key={srv.id} style={{ gap: t.space.md }}>
              <View style={s.botRow}>
                <AgentFace server={srv} size={44} still />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.botName}>{srv.bot.title}</Text>
                  <Text style={s.meta} numberOfLines={2}>{info ? `Plugin ${info.version || '?'}, Hermes ${info.hermes_version || 'unknown'}` : 'Connect to see versions'}</Text>
                </View>
                <Button size="sm" variant="secondary" title="Connection" icon={<Activity size={15} color={t.colors.text} />} onPress={() => router.push(`/connection/${srv.id}`)} />
              </View>
              {compat === 'update-app' ? (
                <Text style={s.warn}>Update this app to connect to {srv.bot.title}.</Text>
              ) : compat === 'update-server' || behind ? (
                <Text style={s.warn}>
                  {compat ? 'Update needed' : 'Update available'}: on the server, run <Text style={s.mono}>hermes plugins update winglet</Text>, then restart the gateway.
                </Text>
              ) : null}
            </Card>
          );
        })}
      </View>

      {appUpdateSupported ? <AppUpdateCard appVersion={appVersion} /> : null}

      <SectionHeader title="Storage" />
      <Card style={{ gap: 12 }}>
        <Text style={s.note}>Clearing the offline cache keeps your full history on the server.</Text>
        <Button title={cleared ? 'Cleared' : 'Clear cached messages'} variant="secondary" icon={<HardDrive size={16} color={t.colors.text} />}
          onPress={async () => { await clearCache(); setCleared(true); }} />
      </Card>

      <SectionHeader title="Help" />
      <ListGroup>
        <ListRow title="App protocol" value={String(APP_PROTOCOL)} />
        <ListRow icon={<FileText size={18} color={t.colors.textSecondary} />} title="Open-source notices" onPress={() => router.push('/open-source-notices')} />
        <ListRow icon={<ExternalLink size={18} color={t.colors.textSecondary} />} title="Source code & help" onPress={() => Linking.openURL('https://github.com/VIKASRP24/winglet')} />
      </ListGroup>
    </Screen>
  );
}

/** Whether a newer Android app is out, with a download, and the switch for looking. */
function AppUpdateCard({ appVersion }: { appVersion: string }) {
  const t = useTheme();
  const s = useStyles();
  const enabled = usePrefs((st) => st.prefs.updateCheck);
  const setPrefs = usePrefs((st) => st.update);
  const { update, checking, checkedAt, failed, check } = useAppUpdate();
  useEffect(() => {
    if (enabled) check();
  }, [enabled, check]);
  const status = checking ? 'Checking…'
    : update ? `Winglet ${update.version} available`
    : failed ? "Couldn't reach GitHub."
    : checkedAt ? `Up to date (checked ${agoText(checkedAt / 1000)})`
    : enabled ? '' : 'Automatic checks off; releases are on GitHub.';
  return (
    <>
      <SectionHeader title="App updates" />
      <View style={{ gap: 10 }}>
        <Card style={{ gap: 12 }}>
          {status ? <Text style={update ? s.good : s.note}>{status}</Text> : null}
          {update ? (
            <>
              {update.notes ? <Text style={s.note}>{update.notes}</Text> : null}
              <InstallButton update={update} />
              <Button title="What's new" variant="secondary" icon={<ExternalLink size={16} color={t.colors.text} />} onPress={() => Linking.openURL(update.page)} />
            </>
          ) : (
            <Button title="Check now" variant="secondary" loading={checking} icon={<RefreshCw size={16} color={t.colors.text} />} onPress={() => check(true)} />
          )}
        </Card>
        <ListGroup>
          <ListRow icon={<CircleArrowUp size={18} color={t.colors.textSecondary} />} title="Check automatically" value="Twice daily"
            right={<Toggle label="Check for app updates automatically" value={enabled} onValueChange={(on) => setPrefs({ updateCheck: on })} />} />
        </ListGroup>
      </View>
    </>
  );
}

const useStyles = makeStyles((t) => ({
  hero: {
    alignItems: 'center', gap: t.space.sm, marginTop: t.space.lg, paddingVertical: t.space.xl, paddingHorizontal: t.space.lg,
    backgroundColor: t.colors.surface, borderRadius: t.radius.xl, borderWidth: 1, borderColor: t.colors.border,
  },
  app: { ...t.type.title, color: t.colors.text, marginTop: t.space.sm },
  pills: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: t.space.sm },
  pill: { paddingHorizontal: t.space.md, paddingVertical: t.space.xs, borderRadius: t.radius.pill, backgroundColor: t.colors.pressed, borderWidth: 1, borderColor: t.colors.border },
  pillText: { ...t.type.caption, color: t.colors.textSecondary },
  meta: { ...t.type.footnote, color: t.colors.textSecondary, marginTop: 2 },
  botRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  botName: { ...t.type.bodyStrong, color: t.colors.text },
  warn: { ...t.type.callout, color: t.colors.warning },
  mono: { fontFamily: t.fonts.mono, color: t.colors.text },
  note: { ...t.type.callout, color: t.colors.textSecondary },
  good: { ...t.type.callout, color: t.colors.success },
}));
