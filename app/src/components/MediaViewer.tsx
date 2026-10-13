import { Directory, File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import * as Sharing from 'expo-sharing';
import { useEffect, useRef, useState } from 'react';
import { FlatList, Modal, Platform, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLock } from '../lib/appLock';
import { haptic } from '../lib/haptics';
import { spring } from '../lib/motion';
import { useApp } from '../lib/store';
import { FIXED } from '../lib/theme';
import { makeStyles } from '../lib/themeContext';
import { Share, X } from './icons';
import { IconButton } from './ui';

export type ViewerItem = { uri: string; name: string };

/**
 * Full-screen photos: pinch or double-tap to zoom, drag to pan, swipe down to close, swipe sideways
 * between photos in the same message. Share hands the file to the system (save to gallery, send on).
 */
export function MediaViewer({ items, index, onClose }: { items: ViewerItem[]; index: number | null; onClose: () => void }) {
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  // The photo showing: the one opened, then wherever it's swiped to. It outlasts the lock, so the viewer comes
  // back on it.
  const [opened, setOpened] = useState(index);
  const [current, setCurrent] = useState(index ?? 0);
  const [zoomed, setZoomed] = useState(false);
  const locked = useLock((st) => st.locked);
  const backdrop = useSharedValue(1);
  const list = useRef<FlatList<ViewerItem>>(null);
  if (index !== opened) {
    setOpened(index);
    if (index !== null) setCurrent(index);
  }
  const selected = index !== opened && index !== null ? index : current;

  useEffect(() => {
    if (index !== null) backdrop.value = 1;
  }, [index, locked, backdrop]);

  const bg = useAnimatedStyle(() => ({ opacity: backdrop.value }));
  // A native modal sits above the lock screen: hide the photos while locked. They come back unzoomed.
  if (locked && zoomed) setZoomed(false);
  if (index === null || locked) return null;
  const item = items[selected] ?? items[0];

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View style={[s.backdrop, bg]} />
        <FlatList
          ref={list}
          data={items}
          horizontal
          pagingEnabled
          scrollEnabled={!zoomed && items.length > 1}
          initialScrollIndex={selected}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          keyExtractor={(it, i) => `${it.uri}-${i}`}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(e) => setCurrent(Math.round(e.nativeEvent.contentOffset.x / width))}
          renderItem={({ item: it }) => (
            <ZoomableImage uri={it.uri} name={it.name} width={width} onZoom={setZoomed} onDismiss={onClose} backdrop={backdrop} />
          )}
        />
        <View style={[s.bar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
          <IconButton label="Close" variant="plain" onPress={onClose}><X size={26} color={FIXED.white} /></IconButton>
          {items.length > 1 ? <Text style={s.count}>{selected + 1} of {items.length}</Text> : <View />}
          <IconButton label={`Share ${item?.name ?? 'photo'}`} onPress={() => item && shareMedia(item)}><Share size={22} color={FIXED.white} /></IconButton>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

function ZoomableImage({ uri, name, width, onZoom, onDismiss, backdrop }: {
  uri: string; name: string; width: number; onZoom: (z: boolean) => void; onDismiss: () => void;
  backdrop: { value: number };
}) {
  const { height } = useWindowDimensions();
  const scale = useSharedValue(1);
  const base = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  const pinch = Gesture.Pinch()
    .onUpdate((e) => { scale.value = Math.max(1, Math.min(5, base.value * e.scale)); })
    .onEnd(() => {
      base.value = scale.value;
      if (scale.value <= 1.02) {
        scale.value = withSpring(1, spring.soft);
        base.value = 1;
        x.value = withSpring(0, spring.soft);
        y.value = withSpring(0, spring.soft);
      }
      runOnJS(onZoom)(scale.value > 1.02);
    });

  const pan = Gesture.Pan()
    .averageTouches(true)
    .onStart(() => { startX.value = x.value; startY.value = y.value; })
    .onUpdate((e) => {
      if (scale.value > 1.02) {
        x.value = startX.value + e.translationX;
        y.value = startY.value + e.translationY;
      } else {
        // Not zoomed: only a downward drag, which closes the viewer.
        y.value = Math.max(0, e.translationY);
        backdrop.value = 1 - Math.min(0.8, y.value / 400);
      }
    })
    .onEnd((e) => {
      if (scale.value > 1.02) return;
      if (y.value > 120 || e.velocityY > 900) {
        y.value = withTiming(height, { duration: 180 });
        runOnJS(onDismiss)();
      } else {
        y.value = withSpring(0, spring.soft);
        backdrop.value = withTiming(1, { duration: 150 });
      }
    });

  const doubleTap = Gesture.Tap().numberOfTaps(2).onEnd(() => {
    const zoom = scale.value > 1.02 ? 1 : 2.5;
    scale.value = withSpring(zoom, spring.soft);
    base.value = zoom;
    x.value = withSpring(0, spring.soft);
    y.value = withSpring(0, spring.soft);
    runOnJS(onZoom)(zoom > 1);
    runOnJS(haptic.selection)();
  });

  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }] }));
  return (
    <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, doubleTap)}>
      <Animated.View style={[{ width, height, alignItems: 'center', justifyContent: 'center' }, style]}>
        <Image source={{ uri }} style={{ width, height: height * 0.85 }} contentFit="contain" accessibilityLabel={name} />
      </Animated.View>
    </GestureDetector>
  );
}

/** Hand a photo or file to the system share sheet; on the web, download it. */
export async function shareMedia(item: ViewerItem) {
  try {
    if (Platform.OS === 'web') {
      const nav = globalThis.navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
      const absolute = new URL(item.uri, globalThis.location?.href).toString();
      if (nav.share && /Android|iPhone|iPad/.test(nav.userAgent)) {
        await nav.share({ title: item.name, url: absolute });
      } else {
        const a = document.createElement('a');
        a.href = absolute;
        a.download = item.name;
        a.rel = 'noopener';
        a.click();
      }
      return;
    }
    const dir = new Directory(Paths.cache, 'shared');
    if (!dir.exists) dir.create({ intermediates: true });
    const target = new File(dir, item.name);
    if (target.exists) target.delete();
    const file = await File.downloadFileAsync(item.uri, target);
    await Sharing.shareAsync(file.uri, { dialogTitle: item.name });
  } catch (e) {
    const serverId = useApp.getState().selection.serverId ?? '';
    useApp.getState().toast({ serverId, title: "Couldn't share", body: (e as Error).message });
  }
}

const useStyles = makeStyles((t) => ({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: FIXED.camera },
  bar: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10 },
  count: { color: FIXED.white, fontFamily: t.fonts.semibold, fontSize: 15 },
}));
