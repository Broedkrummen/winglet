import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { BotAvatar } from '../components/BotAvatar';
import { Activity, CircleArrowUp, Download, ExternalLink, HardDrive, RefreshCw } from '../components/icons';
import { Logo } from '../components/Logo';
import { Screen } from '../components/Screen';
import { Button, Card, ListGroup, ListRow, SectionHeader, Toggle } from '../components/ui';
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
        <Logo size={64} />
        <Text style={s.app}>Winglet {appVersion}</Text>
        <Text style={s.small}>Protocol {APP_PROTOCOL} · open source · not affiliated with Nous Research</Text>
      </View>

      <SectionHeader title="Your bots" />
      <View style={{ gap: 10 }}>
        {servers.map((srv) => {
          const info = runtime[srv.id]?.info;
          const compat = runtime[srv.id]?.compat;
          const behind = !!info?.version && !!appVersion && compareVersions(info.version, appVersion) < 0;
          return (
            <Card key={srv.id} style={{ gap: 10 }}>
              <View style={s.botRow}>
                <BotAvatar name={srv.bot.name} size={36} />
                <View style={{ flex: 1 }}>
                  <Text style={s.botName}>{srv.bot.title}</Text>
                  <Text style={s.small}>{info ? `Winglet ${info.version || '?'} · Hermes ${info.hermes_version || 'unknown'}` : 'Versions show once connected'}</Text>
                </View>
                <Button size="sm" variant="secondary" title="Connection" icon={<Activity size={15} color={t.colors.text} />} onPress={() => router.push(`/connection/${srv.id}`)} />
              </View>
              {compat === 'update-app' ? (
                <Text style={s.warn}>This app is too old for {srv.bot.title}. Install the latest Winglet app.</Text>
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
        <Text style={s.note}>Recent messages are kept on this device so chats open instantly and can be read offline. Your server keeps the full history.</Text>
        <Button title={cleared ? 'Cleared' : 'Clear cached messages'} variant="secondary" icon={<HardDrive size={16} color={t.colors.text} />}
          onPress={async () => { await clearCache(); setCleared(true); }} />
      </Card>

      <SectionHeader title="Help" />
      <ListGroup>
        <ListRow icon={<ExternalLink size={18} color={t.colors.onAccentSoft} />} title="Source code & help" onPress={() => Linking.openURL('https://github.com/VIKASRP24/winglet')} />
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
    : update ? `Winglet ${update.version} is out. You have ${appVersion}.`
    : failed ? "Couldn't reach GitHub. Try again later."
    : checkedAt ? `Up to date · checked ${agoText(checkedAt / 1000)}`
    : enabled ? '' : 'Not checking. New versions are on GitHub Releases.';
  return (
    <>
      <SectionHeader title="App updates" />
      <View style={{ gap: 10 }}>
        <Card style={{ gap: 12 }}>
          {status ? <Text style={update ? s.good : s.note}>{status}</Text> : null}
          {update ? (
            <>
              <Button title={`Download ${update.version}`} icon={<Download size={16} color={t.colors.onAccent} />}
                onPress={() => Linking.openURL(update.apk ?? update.page)} />
              {update.apk ? <Button title="What's new" variant="secondary" onPress={() => Linking.openURL(update.page)} /> : null}
              <Text style={s.small}>It installs over this version and keeps your bots and chats.</Text>
            </>
          ) : (
            <Button title="Check now" variant="secondary" loading={checking} icon={<RefreshCw size={16} color={t.colors.text} />} onPress={() => check(true)} />
          )}
        </Card>
        <ListGroup>
          <ListRow icon={<CircleArrowUp size={18} color={t.colors.onAccentSoft} />} title="Check automatically" subtitle="Looks on GitHub twice a day"
            right={<Toggle label="Check for app updates automatically" value={enabled} onValueChange={(on) => setPrefs({ updateCheck: on })} />} />
        </ListGroup>
      </View>
    </>
  );
}

const useStyles = makeStyles((t) => ({
  hero: { alignItems: 'center', gap: 6, paddingVertical: 16 },
  app: { ...t.type.title, color: t.colors.text, marginTop: 8 },
  small: { ...t.type.caption, color: t.colors.textSecondary, textAlign: 'center' },
  botRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  botName: { ...t.type.bodyStrong, color: t.colors.text },
  warn: { ...t.type.callout, color: t.colors.warning },
  mono: { fontFamily: t.fonts.mono, color: t.colors.text },
  note: { ...t.type.callout, color: t.colors.textSecondary },
  good: { ...t.type.callout, color: t.colors.success },
}));
