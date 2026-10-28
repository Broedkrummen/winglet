import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { hasSigningKey } from '../lib/api';
import { useLock } from '../lib/appLock';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Server } from '../lib/types';
import { useVerify } from '../lib/verify';
import { KeyRound, QrCode } from './icons';
import { Sheet } from './Sheet';
import { Button, Card } from './ui';

/** An owner's phone that can't sign owner actions yet: never verified, or its signing key was lost. */
export function useNeedsVerify(server?: Server): boolean {
  const me = useApp((st) => (server ? st.runtime[server.id]?.me : undefined));
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  useEffect(() => {
    if (server) hasSigningKey(server).then(setHasKey);
  }, [server?.id, me?.verified]); // eslint-disable-line react-hooks/exhaustive-deps
  return !!me && me.role === 'owner' && hasKey !== null && (!me.verified || !hasKey);
}

function startVerify() {
  // Scanning a fresh code from a server this phone already has verifies it (see the scan screen).
  router.push(Platform.OS === 'web' ? '/devices' : '/scan');
}

function HowTo() {
  const s = useStyles();
  return (
    <Text style={s.body}>
      Run <Text style={s.mono}>hermes winglet pair</Text> on the server, or use Devices → Add a device on a verified phone.
      {' '}Scan the code{Platform.OS === 'web' ? ' or paste its link in Devices' : ''}; your chats stay unchanged.
    </Text>
  );
}

/** Asked for by any owner action the server refused because this phone isn't verified. */
export function VerifySheet() {
  const t = useTheme();
  const s = useStyles();
  const serverId = useVerify((st) => st.serverId);
  const close = useVerify((st) => st.close);
  const server = useApp((st) => st.servers.find((x) => x.id === serverId));
  const locked = useLock((st) => st.locked);
  const [last, setLast] = useState(server);
  if (server && server !== last) setLast(server);
  const shown = server ?? last;
  // Unmount the native modal immediately when locked; Sheet otherwise stays above the lock screen.
  if (!shown || locked) return null;
  return (
    <Sheet visible={!!server} onClose={close} title="Verify this phone">
      <View style={{ gap: 14, paddingHorizontal: 4 }}>
        <View style={s.badge}><KeyRound size={22} color={t.colors.warning} /></View>
        <Text style={s.lead}>
          Verify this phone to manage {shown.bot.title}.
        </Text>
        <HowTo />
        <Button title={Platform.OS === 'web' ? 'Open Devices' : 'Scan the code'} icon={<QrCode size={16} color={t.colors.onAccent} />}
          onPress={() => { close(); startVerify(); }} />
        <Button title="Not now" variant="secondary" onPress={close} />
      </View>
    </Sheet>
  );
}

/** On owner screens, before an action fails: what's missing and the one step that fixes it. */
export function VerifyNotice({ server }: { server: Server }) {
  const t = useTheme();
  const s = useStyles();
  if (!useNeedsVerify(server)) return null;
  return (
    <Card style={{ gap: 10, marginTop: 14 }}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <KeyRound size={18} color={t.colors.warning} />
        <Text style={[s.lead, { flex: 1 }]}>Verify this phone to restart, update and change settings</Text>
      </View>
      <HowTo />
      <Button size="sm" variant="tonal" title={Platform.OS === 'web' ? 'Open Devices' : 'Scan the code'} onPress={startVerify} />
    </Card>
  );
}

const useStyles = makeStyles((t) => ({
  badge: { width: 56, height: 56, borderRadius: t.radius.pill, backgroundColor: t.colors.warningSoft, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  lead: { ...t.type.bodyStrong, color: t.colors.text },
  body: { ...t.type.callout, color: t.colors.textSecondary },
  mono: { fontFamily: t.fonts.mono, color: t.colors.text },
}));
