import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeInDown, ZoomIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { BotAvatar } from '../components/BotAvatar';
import { BellRing, ChevronLeft, QrCode, Server as ServerIcon, Share, ShieldCheck, SquarePlus } from '../components/icons';
import { Logo } from '../components/Logo';
import { Button, Field, IconButton } from '../components/ui';
import { defaultDeviceName, fetchInfo, normalizeUrl, pair, parsePairLink } from '../lib/api';
import { isIOS, isStandalone } from '../lib/push';
import { useApp } from '../lib/store';
import { BRAND } from '../lib/theme';
import { makeStyles, useTheme } from '../lib/themeContext';
import { easeOut } from '../lib/motion';

const FEATURES = [
  { icon: ServerIcon, title: 'Runs on your machine', text: 'Your Hermes agents, your models, your data.' },
  { icon: BellRing, title: 'Taps you when needed', text: 'Approvals, questions and results as notifications.' },
  { icon: ShieldCheck, title: 'You stay in control', text: 'Approve anything risky, from anywhere.' },
];

export default function PairScreen() {
  const t = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
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
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 560 }}>
        <Svg width={width} height={560}>
          <Defs>
            <RadialGradient id="g1" cx="30%" cy="12%" rx="65%" ry="40%">
              <Stop offset="0" stopColor={BRAND.from} stopOpacity={t.scheme === 'dark' ? 0.45 : 0.22} />
              <Stop offset="1" stopColor={BRAND.from} stopOpacity={0} />
            </RadialGradient>
            <RadialGradient id="g2" cx="85%" cy="28%" rx="55%" ry="35%">
              <Stop offset="0" stopColor={BRAND.to} stopOpacity={t.scheme === 'dark' ? 0.35 : 0.18} />
              <Stop offset="1" stopColor={BRAND.to} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect x={0} y={0} width={width} height={560} fill="url(#g1)" />
          <Rect x={0} y={0} width={width} height={560} fill="url(#g2)" />
        </Svg>
      </View>
      <ScrollView contentContainerStyle={[s.scroll, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 28 }]} keyboardShouldPersistTaps="handled">
        {hasServers ? (
          <IconButton label="Back" variant="filled" style={{ alignSelf: 'flex-start' }} onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}>
            <ChevronLeft size={24} color={t.colors.text} />
          </IconButton>
        ) : null}

        <Animated.View entering={ZoomIn.duration(220).easing(easeOut)} style={s.family}>
          <BotAvatar name="atlas" size={58} mood="happy" animated style={{ marginRight: -14, marginTop: 26 }} />
          <BotAvatar name="hermes" size={92} mood="idle" animated glow />
          <BotAvatar name="nova" size={58} mood="idle" animated style={{ marginLeft: -14, marginTop: 26 }} />
        </Animated.View>
        <View style={s.hero}>
          <View style={s.brandRow}><Logo size={28} /><Text style={s.brand}>Winglet</Text></View>
          <Text style={s.tagline}>{hasServers ? 'Add another bot' : 'Your agents,\nin your pocket.'}</Text>
        </View>

        {!hasServers ? (
          <View style={s.features}>
            {FEATURES.map(({ icon: Icon, title, text }, i) => (
              <Animated.View key={title} entering={FadeInDown.delay(120 + i * 80).duration(260).easing(easeOut)} style={s.feature}>
                <View style={s.featureIcon}><Icon size={20} color={t.colors.onAccentSoft} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.featureTitle}>{title}</Text>
                  <Text style={s.featureText}>{text}</Text>
                </View>
              </Animated.View>
            ))}
          </View>
        ) : null}

        <Animated.View entering={FadeInDown.delay(320).duration(260).easing(easeOut)} style={s.card}>
          {showInstall ? (
            <>
              <Text style={s.cardTitle}>Install Winglet on your iPhone</Text>
              <Text style={s.cardText}>Notifications on iPhone need Winglet on your Home Screen. It takes five seconds:</Text>
              <View style={s.step}><Share size={18} color={t.colors.accent} /><Text style={s.stepText}>Tap <Text style={s.bold}>Share</Text> in Safari's toolbar</Text></View>
              <View style={s.step}><SquarePlus size={18} color={t.colors.accent} /><Text style={s.stepText}>Choose <Text style={s.bold}>Add to Home Screen</Text></Text></View>
              <View style={s.step}><QrCode size={18} color={t.colors.accent} /><Text style={s.stepText}>Open Winglet from your Home Screen and enter code <Text style={s.code}>{formatCode(params.code ?? '')}</Text></Text></View>
              <Button title="Continue in Safari instead" variant="ghost" onPress={() => setSkipInstall(true)} />
            </>
          ) : (
            <>
              <Text style={s.cardTitle}>{params.code ? 'Pairing…' : 'Connect to your Hermes'}</Text>
              <Text style={s.cardText}>
                On the machine running Hermes, run <Text style={s.code}>hermes winglet pair</Text> and {Platform.OS === 'web' ? 'enter the code below.' : 'scan the QR code it shows.'}
              </Text>
              {Platform.OS !== 'web' ? (
                <Button size="lg" title="Scan QR code" icon={<QrCode size={20} color={t.colors.onAccent} />} onPress={() => router.push('/scan')} />
              ) : null}
              {manual ? (
                <View style={{ gap: 14, marginTop: 4 }}>
                  <Field label="Server address" value={url} onChangeText={setUrl} placeholder="192.168.1.20:8787 or https://box.ts.net" autoCapitalize="none" autoCorrect={false} keyboardType="url" />
                  <Field label="Pairing code" value={code} onChangeText={setCode} placeholder="ABCD-2345" autoCapitalize="characters" autoCorrect={false}
                    style={s.codeInput} onSubmitEditing={() => connect()} />
                  <Field label="This device's name" value={deviceName} onChangeText={setDeviceName} placeholder="My phone" />
                  <Button size="lg" title="Connect" loading={busy} onPress={() => connect()} variant={Platform.OS === 'web' ? 'primary' : 'secondary'} />
                </View>
              ) : (
                <Button title="Enter a code instead" variant="ghost" onPress={() => setManual(true)} />
              )}
              {error ? <Text style={s.error} accessibilityRole="alert">{error}</Text> : null}
            </>
          )}
        </Animated.View>

        <Text style={s.footer}>
          New here? Winglet is an app for <Text style={s.bold}>Hermes Agent</Text>. Install the Winglet plugin on your Hermes machine first: see github.com/VIKASRP24/winglet
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function formatCode(code: string) {
  const c = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

const useStyles = makeStyles((t) => ({
  root: { flex: 1, backgroundColor: t.colors.bg },
  scroll: { flexGrow: 1, paddingHorizontal: 20, alignItems: 'center', gap: 22 },
  family: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center', marginTop: 24 },
  hero: { alignItems: 'center', gap: 10 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brand: { ...t.type.heading, color: t.colors.text },
  tagline: { ...t.type.display, fontSize: 34, lineHeight: 40, color: t.colors.text, textAlign: 'center' },
  features: { width: '100%', maxWidth: 440, gap: 10 },
  feature: {
    flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: t.radius.lg,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
  },
  featureIcon: { width: 40, height: 40, borderRadius: 13, backgroundColor: t.colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  featureTitle: { ...t.type.bodyStrong, color: t.colors.text },
  featureText: { ...t.type.callout, color: t.colors.textSecondary, marginTop: 1 },
  card: {
    width: '100%', maxWidth: 440, backgroundColor: t.colors.surface, borderRadius: t.radius.xl, padding: 20, gap: 14,
    borderWidth: 1, borderColor: t.colors.border,
  },
  cardTitle: { ...t.type.title, color: t.colors.text },
  cardText: { ...t.type.callout, fontSize: 15, lineHeight: 22, color: t.colors.textSecondary },
  code: { fontFamily: t.fonts.mono, color: t.colors.text, backgroundColor: t.colors.surfaceSunken, fontSize: 14 },
  codeInput: { fontFamily: t.fonts.bold, fontSize: 22, letterSpacing: 4, textAlign: 'center' },
  bold: { fontFamily: t.fonts.semibold, color: t.colors.text },
  step: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: t.colors.surfaceSunken, borderRadius: t.radius.md, padding: 12 },
  stepText: { flex: 1, ...t.type.callout, fontSize: 15, color: t.colors.text },
  error: { ...t.type.callout, color: t.colors.danger },
  footer: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textSecondary, textAlign: 'center', maxWidth: 400, lineHeight: 18 },
}));
