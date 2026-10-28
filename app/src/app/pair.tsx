import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BotAvatar } from '../components/BotAvatar';
import { ArrowLeft, ExternalLink, KeyRound, QrCode, Share, SquarePlus } from '../components/icons';
import { Logo } from '../components/Logo';
import { Button, Field, IconButton } from '../components/ui';
import { defaultDeviceName, fetchInfo, normalizeUrl, pair, parsePairLink } from '../lib/api';
import { useReducedMotion } from '../lib/motion';
import { isIOS, isStandalone } from '../lib/push';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';

export default function PairScreen() {
  const t = useTheme();
  const s = useStyles();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ code?: string; url?: string; fp?: string }>();
  const hasServers = useApp((st) => st.servers.length > 0);
  const addServer = useApp((st) => st.addServer);
  const [url, setUrl] = useState(params.url ?? '');
  const [code, setCode] = useState(params.code ?? '');
  const [deviceName, setDeviceName] = useState(defaultDeviceName());
  const [manual, setManual] = useState(!!params.code || Platform.OS === 'web');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoTried = useRef(false);
  const iosBrowser = isIOS() && !isStandalone();
  const [skipInstall, setSkipInstall] = useState(false);

  // On the web app served by a Winglet server, default to that server.
  useEffect(() => {
    if (Platform.OS !== 'web' || url) return;
    const origin = globalThis.location?.origin;
    if (!origin || origin.startsWith('http://localhost:8081')) return;
    fetchInfo(origin).then(() => setUrl(origin)).catch(() => undefined);
  }, [url]);

  const connect = async (u = url, c = code, fp = params.fp) => {
    const link = parsePairLink(u);
    const target = link ? link.url : normalizeUrl(u);
    const theCode = link ? link.code : c;
    const fingerprint = link ? link.fp : fp;
    if (!target || !theCode) {
      setError('Enter your server address and the code from `hermes winglet pair`.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const server = await pair(target, theCode, deviceName.trim() || defaultDeviceName(), fingerprint);
      await addServer(server);
      router.replace('/');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Links like https://box/#pair=CODE pair straight away (unless iPhone should install first).
  useEffect(() => {
    if (params.code && params.url && !autoTried.current && (!iosBrowser || skipInstall)) {
      autoTried.current = true;
      connect(params.url, params.code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.code, params.url, iosBrowser, skipInstall]);

  const showInstall = iosBrowser && !skipInstall;

  return (
    <View style={s.root}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={[s.scroll, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
          {hasServers ? (
            <IconButton label="Back" style={{ alignSelf: 'flex-start' }} onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}>
              <ArrowLeft size={22} color={t.colors.text} />
            </IconButton>
          ) : null}

          <Animated.View entering={reduced ? undefined : FadeIn.duration(260)} style={s.column}>
            <View style={s.brand}>
              <Logo size={26} />
              <Text style={s.brandText}>Winglet</Text>
            </View>

            <View style={s.family} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <BotAvatar name="atlas" size={44} mood="happy" animated style={{ marginRight: -8, marginTop: 22 }} />
              <BotAvatar name="hermes" size={80} mood="idle" animated />
              <BotAvatar name="nova" size={44} mood="idle" animated style={{ marginLeft: -8, marginTop: 22 }} />
            </View>

            <View style={s.hero}>
              <Text style={s.tagline} accessibilityRole="header">
                {showInstall ? 'Install on your iPhone' : params.code ? 'Pairing…' : hasServers ? 'Add another bot' : 'Your agents, in your pocket'}
              </Text>
              <Text style={s.context}>
                {showInstall ? 'Add Winglet to your Home Screen for notifications.'
                  : <>Run <Text style={s.code}>hermes winglet pair</Text> on your server, then {Platform.OS === 'web' ? 'enter the code it shows' : 'scan the code it shows'}.</>}
              </Text>
            </View>

            {showInstall ? (
              <View style={s.actions}>
                <View style={s.panel}>
                  <Step n={1} icon={<Share size={18} color={t.colors.textSecondary} />}>Tap <Text style={s.bold}>Share</Text> in the Safari toolbar</Step>
                  <Step n={2} icon={<SquarePlus size={18} color={t.colors.textSecondary} />}>Choose <Text style={s.bold}>Add to Home Screen</Text></Step>
                  <Step n={3} icon={<QrCode size={18} color={t.colors.textSecondary} />}>
                    Open Winglet there{params.code ? <> and enter <Text style={s.code}>{formatCode(params.code)}</Text></> : null}
                  </Step>
                </View>
                <Button size="lg" variant="secondary" title="Continue in Safari instead" onPress={() => setSkipInstall(true)} />
              </View>
            ) : (
              <View style={s.actions}>
                {Platform.OS !== 'web' ? (
                  <Button size="lg" title="Scan QR code" icon={<QrCode size={19} color={t.colors.onInk} />} onPress={() => router.push('/scan')} />
                ) : null}
                {manual ? (
                  <View style={[s.panel, { gap: t.space.lg }]}>
                    <Field label="Server address" value={url} onChangeText={setUrl} placeholder="192.168.1.20:8787 or https://box.ts.net" autoCapitalize="none" autoCorrect={false} keyboardType="url" />
                    <Field label="Pairing code" value={code} onChangeText={setCode} placeholder="ABCD-2345" autoCapitalize="characters" autoCorrect={false}
                      style={s.codeInput} onSubmitEditing={() => connect()} />
                    <Field label="This device's name" value={deviceName} onChangeText={setDeviceName} placeholder="My phone" />
                    <Button size="lg" title="Connect" loading={busy} onPress={() => connect()} variant={Platform.OS === 'web' ? 'primary' : 'secondary'} />
                  </View>
                ) : (
                  <Button size="lg" variant="secondary" title="Enter a code instead" icon={<KeyRound size={17} color={t.colors.text} />} onPress={() => setManual(true)} />
                )}
                {error ? <Text style={s.error} accessibilityRole="alert">{error}</Text> : null}
              </View>
            )}

            <Button size="sm" variant="ghost" title="Set up the server plugin" icon={<ExternalLink size={14} color={t.colors.accent} />}
              style={{ alignSelf: 'center' }} onPress={() => Linking.openURL('https://github.com/VIKASRP24/winglet')} />
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function Step({ n, icon, children }: { n: number; icon: ReactNode; children: ReactNode }) {
  const s = useStyles();
  return (
    <View style={s.step}>
      {icon}
      <Text style={s.stepText}><Text style={s.stepNumber}>{n}. </Text>{children}</Text>
    </View>
  );
}

function formatCode(code: string) {
  const c = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

const useStyles = makeStyles((t) => ({
  root: { flex: 1, backgroundColor: t.colors.bg },
  scroll: { flexGrow: 1, paddingHorizontal: t.space.xl },
  column: { flex: 1, width: '100%', maxWidth: 400, alignSelf: 'center', justifyContent: 'center', gap: 28, paddingVertical: t.space.lg },
  brand: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: t.space.sm },
  brandText: { ...t.type.heading, color: t.colors.text },
  family: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center' },
  hero: { alignItems: 'center', gap: t.space.sm },
  tagline: { ...t.type.display, color: t.colors.text, textAlign: 'center' },
  context: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center', maxWidth: 320 },
  actions: { gap: t.space.md },
  panel: {
    borderRadius: t.radius.lg, padding: t.space.lg, gap: t.space.xs, backgroundColor: t.colors.surface,
    borderWidth: StyleSheet.hairlineWidth * 2, borderColor: t.colors.border,
  },
  code: { ...t.type.callout, fontFamily: t.fonts.mono, color: t.colors.text },
  codeInput: { ...t.type.title, letterSpacing: 4, textAlign: 'center' },
  bold: { fontFamily: t.fonts.semibold, color: t.colors.text },
  step: { flexDirection: 'row', alignItems: 'center', gap: t.space.md, paddingVertical: t.space.sm },
  stepNumber: { fontFamily: t.fonts.semibold, color: t.colors.textSecondary },
  stepText: { flex: 1, ...t.type.callout, color: t.colors.text },
  error: { ...t.type.callout, color: t.colors.danger, textAlign: 'center' },
}));
