import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import type { AppUpdate } from '../lib/appUpdate';
import { useAppInstall } from '../lib/appInstall';
import { appUpdateSupported, useAppUpdate } from '../lib/appUpdateCheck';
import { useLock } from '../lib/appLock';
import { usePrefs } from '../lib/prefs';
import { getJSON, setJSON } from '../lib/storage';
import { makeStyles, useTheme } from '../lib/themeContext';
import { CircleArrowUp, Download } from './icons';
import { Sheet } from './Sheet';
import { Button } from './ui';

const SKIP_KEY = 'winglet.appUpdate.skip';
/** Versions put off with "Later" since the app started: asked again on the next start, not before. */
const putOff = new Set<string>();

/**
 * Asks once per start when a newer Android app is out. Never required: "Later" asks again next
 * time, "Skip this version" waits for the one after.
 */
export function UpdatePrompt() {
  const s = useStyles();
  const enabled = usePrefs((st) => st.prefs.updateCheck);
  const update = useAppUpdate((st) => st.update);
  const locked = useLock((st) => st.locked);
  const downloading = useAppInstall((st) => st.phase === 'downloading');
  const [skipped, setSkipped] = useState<string | null | undefined>(undefined);
  const [, rerender] = useState(0);
  useEffect(() => {
    getJSON<string | null>(SKIP_KEY, null).catch(() => null).then(setSkipped);
  }, []);
  // Unmount the native modal immediately when locked; Sheet otherwise animates closed over the lock.
  if (!appUpdateSupported || !enabled || !update || skipped === undefined || locked) return null;
  const visible = update.version !== skipped && !putOff.has(update.version);
  // Swiping the sheet away mid-download lets the download finish and the installer open.
  const later = () => {
    putOff.add(update.version);
    rerender((n) => n + 1);
  };
  const skip = () => {
    setSkipped(update.version);
    setJSON(SKIP_KEY, update.version).catch(() => undefined);
    later();
  };
  return (
    <Sheet visible={visible} onClose={later} title="Update available">
      <View style={s.body}>
        <Text style={s.lead}>Winglet {update.version} is out. You have {Constants.expoConfig?.version}.</Text>
        {update.notes ? <Text style={s.notes} numberOfLines={6}>{update.notes}</Text> : null}
        <InstallButton update={update} />
        {downloading ? null : (
          <>
            <Button title="Later" variant="secondary" onPress={later} />
            <Text style={s.link} accessibilityRole="button" onPress={skip}>Skip this version</Text>
          </>
        )}
      </View>
    </Sheet>
  );
}

/** Downloads and installs the update, showing progress; falls back to the release page. */
export function InstallButton({ update }: { update: AppUpdate }) {
  const t = useTheme();
  const s = useStyles();
  const { phase, progress, version, error, install, cancel } = useAppInstall();
  const mine = version === update.version;
  if (mine && phase === 'downloading') {
    return (
      <View style={{ gap: 8 }}>
        <View style={s.track} accessibilityRole="progressbar"
          accessibilityValue={progress == null ? undefined : { min: 0, max: 100, now: Math.round(progress * 100) }}>
          <View style={[s.fill, { width: `${Math.round((progress ?? 0.1) * 100)}%` }]} />
        </View>
        <Text style={s.caption}>Downloading{progress == null ? '…' : ` ${Math.round(progress * 100)}%`}</Text>
        <Button title="Cancel" variant="secondary" onPress={cancel} />
      </View>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      <Button title={mine && phase === 'ready' ? 'Install' : `Update to ${update.version}`}
        icon={update.apk ? <Download size={16} color={t.colors.onAccent} /> : <CircleArrowUp size={16} color={t.colors.onAccent} />}
        onPress={() => install(update)} />
      {mine && phase === 'error' && error ? (
        <Text style={s.error}>
          {error} <Text style={s.inlineLink} onPress={() => Linking.openURL(update.apk ?? update.page)}>Download in the browser</Text>
        </Text>
      ) : (
        <Text style={s.caption}>It installs over this version and keeps your bots and chats.</Text>
      )}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  body: { gap: 12, paddingHorizontal: 4 },
  lead: { ...t.type.bodyStrong, color: t.colors.text },
  notes: { ...t.type.callout, color: t.colors.textSecondary },
  caption: { ...t.type.caption, color: t.colors.textSecondary, textAlign: 'center' },
  error: { ...t.type.callout, color: t.colors.danger },
  inlineLink: { color: t.colors.accent, textDecorationLine: 'underline' },
  link: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center', paddingVertical: 8 },
  track: { height: 6, borderRadius: 3, backgroundColor: t.colors.surfaceSunken, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3, backgroundColor: t.colors.accentFill },
}));
