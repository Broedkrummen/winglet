import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { X } from '../components/icons';
import { useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, IconButton } from '../components/ui';
import { defaultDeviceName, fetchInfo, pair, parsePairLink, verifyDevice } from '../lib/api';
import { useApp } from '../lib/store';
import { FIXED } from '../lib/theme';
import { makeStyles } from '../lib/themeContext';

export default function ScanScreen() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const addServer = useApp((s) => s.addServer);
  const updateServer = useApp((s) => s.updateServer);
  const [status, setStatus] = useState<'scanning' | 'pairing' | 'verifying' | 'error'>('scanning');
  const [error, setError] = useState('');
  const handled = useRef(false);

  const onScan = async (data: string) => {
    if (handled.current) return;
    const link = parsePairLink(data);
    if (!link) {
      setError("That QR code isn't a Winglet pairing code.");
      return;
    }
    handled.current = true;
    try {
      // A code from a server this phone already has verifies the phone instead of pairing it twice.
      const info = await fetchInfo(link.url);
      const existing = useApp.getState().servers.find((x) => x.id === info.server_id);
      if (existing && link.fp) {
        setStatus('verifying');
        const verified = await verifyDevice(existing, link.code, link.fp);
        await updateServer(existing.id, { fingerprint: verified.fingerprint }, true);
        useApp.getState().toast({ serverId: existing.id, title: 'Phone verified', body: `You can manage ${existing.bot.title} from this phone now.` });
        router.back();
        return;
      }
      setStatus('pairing');
      const server = await pair(link.url, link.code, defaultDeviceName(), link.fp);
      await addServer(server);
      router.dismissAll();
      router.replace('/');
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  };

  if (!permission) return <View style={styles.root} />;

  if (!permission.granted) {
    return (
      <View style={[styles.root, styles.center, { padding: 24 }]}>
        <Text style={styles.title}>Camera access</Text>
        <Text style={styles.text}>Winglet needs the camera only to scan the pairing code shown by `hermes winglet pair`.</Text>
        <Button title="Allow camera" onPress={requestPermission} size="lg" style={{ alignSelf: 'stretch' }} />
        <Button title="Enter the code instead" variant="ghost" onPress={() => router.back()} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={status === 'scanning' ? (r) => onScan(r.data) : undefined}
      />
      <View style={[styles.overlay, { paddingTop: insets.top + 8 }]}>
        <IconButton label="Close" onPress={() => router.back()} style={styles.close}>
          <X size={24} color={FIXED.white} />
        </IconButton>
        <View style={styles.frame} />
        <View style={styles.hintBox}>
          {status === 'pairing' || status === 'verifying' ? <ActivityIndicator color={FIXED.white} /> : null}
          <Text style={styles.hint}>
            {status === 'pairing' ? 'Pairing…' : status === 'verifying' ? 'Verifying this phone…'
              : error || 'Point at the QR code from `hermes winglet pair` or another phone'}
          </Text>
          {status === 'error' ? (
            <Button title="Try again" onPress={() => { handled.current = false; setError(''); setStatus('scanning'); }} />
          ) : null}
        </View>
      </View>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  root: { flex: 1, backgroundColor: FIXED.camera },
  center: { alignItems: 'center', justifyContent: 'center', gap: 14, backgroundColor: t.colors.bg },
  title: { ...t.type.title, color: t.colors.text },
  text: { ...t.type.callout, fontSize: 15, color: t.colors.textSecondary, textAlign: 'center' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'space-between', paddingBottom: 60 },
  close: { alignSelf: 'flex-start', marginLeft: 12, backgroundColor: FIXED.cameraScrim, borderRadius: 20 },
  frame: { width: 250, height: 250, borderRadius: 32, borderWidth: 3, borderColor: FIXED.cameraFrame },
  hintBox: { alignItems: 'center', gap: 12, backgroundColor: FIXED.cameraScrim, borderRadius: t.radius.lg, paddingHorizontal: 18, paddingVertical: 14, marginHorizontal: 24 },
  hint: { fontFamily: t.fonts.semibold, fontSize: 15, color: FIXED.white, textAlign: 'center' },
}));
