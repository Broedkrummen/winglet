import { useEffect } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { unlock, useLock } from '../lib/appLock';
import { useReducedMotion } from '../lib/motion';
import { makeStyles, useTheme } from '../lib/themeContext';
import { Fingerprint } from './icons';
import { Logo } from './Logo';
import { Button } from './ui';

/** Covers everything while the app is locked, and asks for the phone's own unlock straight away. */
export function LockScreen() {
  const locked = useLock((st) => st.locked);
  useEffect(() => {
    if (locked) unlock();
  }, [locked]);
  if (!locked) return null;
  return <Cover />;
}

function Cover() {
  const t = useTheme();
  const s = useStyles();
  const reduced = useReducedMotion();
  return (
    <View style={s.cover} accessibilityViewIsModal>
      <Animated.View entering={reduced ? undefined : FadeIn.duration(200)} style={s.column}>
        <Logo size={56} />
        <View style={s.words}>
          <Text style={s.title} accessibilityRole="header">Winglet is locked</Text>
          <Text style={s.sub}>Unlock with your fingerprint, face or passcode.</Text>
        </View>
        <Button title="Unlock" size="lg" style={{ alignSelf: 'stretch' }} icon={<Fingerprint size={19} color={t.colors.onInk} />} onPress={() => unlock()} />
      </Animated.View>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  cover: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100, backgroundColor: t.colors.bg,
    alignItems: 'center', justifyContent: 'center', padding: t.space.xxl,
  },
  column: { width: '100%', maxWidth: 320, alignItems: 'center', gap: t.space.xl },
  words: { alignItems: 'center', gap: t.space.xs },
  title: { ...t.type.title, color: t.colors.text, textAlign: 'center' },
  sub: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center' },
}));
