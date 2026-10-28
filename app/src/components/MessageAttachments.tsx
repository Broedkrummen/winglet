import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useMemo, useState } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import { haptic } from '../lib/haptics';
import { formatDuration, formatSize } from '../lib/media';
import { FIXED } from '../lib/theme';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Attachment } from '../lib/types';
import { FileText, Share, Square } from './icons';
import { MediaViewer, shareMedia, type ViewerItem } from './MediaViewer';
import { Tap } from './ui';
import Svg, { Path } from 'react-native-svg';

/** Photos, voice notes, audio, video and files in a message, laid out for a phone. */
export function MessageAttachments({ items, resolve, mine }: { items: Attachment[]; resolve: (url: string) => string; mine?: boolean }) {
  const s = useStyles();
  const [open, setOpen] = useState<number | null>(null);
  const images = items.filter((a) => a.kind === 'image');
  const others = items.filter((a) => a.kind !== 'image');
  const viewer: ViewerItem[] = useMemo(() => images.map((a) => ({ uri: resolve(a.url), name: a.name })), [images, resolve]);
  return (
    <View style={[s.wrap, mine && { alignItems: 'flex-end' }]}>
      {images.length ? <ImageGrid items={viewer} onOpen={setOpen} /> : null}
      {others.map((a) => (
        a.kind === 'voice' || a.kind === 'audio' ? <AudioPlayer key={a.url} attachment={a} uri={resolve(a.url)} />
          : a.kind === 'video' ? <VideoTile key={a.url} attachment={a} uri={resolve(a.url)} />
            : <FileTile key={a.url} attachment={a} uri={resolve(a.url)} />
      ))}
      <MediaViewer items={viewer} index={open} onClose={() => setOpen(null)} />
    </View>
  );
}

function ImageGrid({ items, onOpen }: { items: ViewerItem[]; onOpen: (i: number) => void }) {
  const s = useStyles();
  const shown = items.slice(0, 4);
  const single = items.length === 1;
  return (
    <View style={[s.grid, single ? s.gridSingle : null]}>
      {shown.map((it, i) => (
        <Tap key={`${it.uri}-${i}`} feedback="light" scaleTo={0.97} accessibilityLabel={`Open photo ${it.name}`} onPress={() => onOpen(i)}
          style={single ? s.single : s.cell}>
          <Image source={{ uri: it.uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" transition={180} accessibilityIgnoresInvertColors />
          {i === 3 && items.length > 4 ? <View style={s.more}><Text style={s.moreText}>+{items.length - 4}</Text></View> : null}
        </Tap>
      ))}
    </View>
  );
}

/** Voice notes and audio: play, pause, seek by tapping the bar. Loads only when first played. */
function AudioPlayer({ attachment, uri }: { attachment: Attachment; uri: string }) {
  const t = useTheme();
  const s = useStyles();
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [loaded, setLoaded] = useState(false);
  const [width, setWidth] = useState(1);
  const voice = attachment.kind === 'voice';
  const progress = status.duration ? status.currentTime / status.duration : 0;
  const bars = useMemo(() => waveform(attachment.url, 28), [attachment.url]);

  const toggle = () => {
    haptic.selection();
    if (!loaded) {
      player.replace({ uri });
      setLoaded(true);
      player.play();
      return;
    }
    if (status.playing) player.pause();
    else {
      if (status.didJustFinish || (status.duration && status.currentTime >= status.duration - 0.05)) player.seekTo(0);
      player.play();
    }
  };

  return (
    <View style={s.audio}>
      <Tap feedback="none" accessibilityLabel={status.playing ? 'Pause' : voice ? 'Play voice note' : `Play ${attachment.name}`} onPress={toggle} style={s.play}>
        {status.playing ? <Square size={14} color={t.colors.onAccent} fill={t.colors.onAccent} /> : (
          <Svg width={16} height={16} viewBox="0 0 16 16"><Path d="M4 2.5v11l9.5-5.5z" fill={t.colors.onAccent} /></Svg>
        )}
      </Tap>
      <View style={{ flex: 1, gap: 4 }}>
        <Pressable accessibilityRole="adjustable" accessibilityLabel="Position" onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
          onPress={(e) => { if (loaded && status.duration) player.seekTo((e.nativeEvent.locationX / width) * status.duration); }}
          style={s.bars}>
          {voice ? bars.map((h, i) => (
            <View key={i} style={[s.bar, { height: 6 + h * 18, backgroundColor: i / bars.length <= progress ? t.colors.accent : t.colors.borderStrong }]} />
          )) : (
            <View style={s.track}><View style={[s.fill, { width: `${progress * 100}%` }]} /></View>
          )}
        </Pressable>
        <Text style={s.audioMeta} numberOfLines={1}>
          {voice ? 'Voice note' : attachment.name} · {status.duration ? formatDuration((status.playing || status.currentTime ? status.currentTime : status.duration) * 1000) : formatSize(attachment.size)}
        </Text>
      </View>
    </View>
  );
}

/** A decorative waveform: the same shape every time for the same note. */
function waveform(seed: string, n: number): number[] {
  let h = 2166136261;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    for (const c of seed + i) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    const v = ((h >>> 0) % 1000) / 1000;
    out.push(0.25 + 0.75 * Math.abs(Math.sin(i * 0.55)) * (0.6 + 0.4 * v));
  }
  return out;
}

/** Video: a still tile until tapped, then the native player with its own controls. */
function VideoTile({ attachment, uri }: { attachment: Attachment; uri: string }) {
  const s = useStyles();
  const [playing, setPlaying] = useState(false);
  if (playing) return <InlineVideo uri={uri} />;
  return (
    <Tap feedback="light" accessibilityLabel={`Play video ${attachment.name}`} onPress={() => setPlaying(true)} style={s.video}>
      <View style={s.videoPlay}>
        <Svg width={22} height={22} viewBox="0 0 16 16"><Path d="M4 2.5v11l9.5-5.5z" fill={FIXED.white} /></Svg>
      </View>
      <Text style={s.videoName} numberOfLines={1}>{attachment.name} · {formatSize(attachment.size)}</Text>
    </Tap>
  );
}

function InlineVideo({ uri }: { uri: string }) {
  const s = useStyles();
  const player = useVideoPlayer(uri, (p) => p.play());
  return <VideoView player={player} style={s.video} nativeControls fullscreenOptions={{ enable: true }} contentFit="contain" />;
}

function FileTile({ attachment, uri }: { attachment: Attachment; uri: string }) {
  const t = useTheme();
  const s = useStyles();
  const ext = attachment.name.split('.').pop()?.toUpperCase().slice(0, 4) ?? 'FILE';
  return (
    <View style={s.file}>
      <Tap feedback="selection" accessibilityRole="link" accessibilityLabel={`Open ${attachment.name}`} style={s.fileMain}
        onPress={() => (Platform.OS === 'web' ? globalThis.open?.(uri, '_blank', 'noopener') : Linking.openURL(uri))}>
        <View style={s.fileIcon}>
          <FileText size={18} color={t.colors.textSecondary} />
          <Text style={s.fileExt}>{ext}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.fileName} numberOfLines={1}>{attachment.name}</Text>
          <Text style={s.fileSize}>{formatSize(attachment.size)}</Text>
        </View>
      </Tap>
      <Tap feedback="selection" accessibilityLabel={`Share ${attachment.name}`} onPress={() => shareMedia({ uri, name: attachment.name })} style={s.fileShare}>
        <Share size={18} color={t.colors.textSecondary} />
      </Tap>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  wrap: { gap: 6, marginTop: 6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, width: 280, borderRadius: t.radius.md, overflow: 'hidden' },
  gridSingle: { width: 'auto' },
  single: { width: 260, height: 210, borderRadius: t.radius.md, overflow: 'hidden', backgroundColor: t.colors.surfaceSunken },
  cell: { width: 138, height: 138, backgroundColor: t.colors.surfaceSunken, overflow: 'hidden' },
  more: { ...{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }, backgroundColor: t.colors.overlay, alignItems: 'center', justifyContent: 'center' },
  moreText: { ...t.type.title, color: t.colors.onAccent },
  audio: {
    flexDirection: 'row', alignItems: 'center', gap: 12, width: 270, padding: 10, borderRadius: t.radius.lg,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
  },
  play: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.accentFill },
  bars: { flexDirection: 'row', alignItems: 'center', gap: 2.5, height: 28 },
  bar: { flex: 1, borderRadius: 2 },
  track: { flex: 1, height: 4, borderRadius: 2, backgroundColor: t.colors.borderStrong, overflow: 'hidden' },
  fill: { height: 4, backgroundColor: t.colors.accent },
  audioMeta: { ...t.type.caption, color: t.colors.textSecondary },
  video: { width: 280, height: 170, borderRadius: t.radius.md, backgroundColor: t.colors.surfaceSunken, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  videoPlay: { width: 54, height: 54, borderRadius: 27, backgroundColor: t.colors.overlay, alignItems: 'center', justifyContent: 'center' },
  videoName: { ...t.type.caption, color: t.colors.textSecondary, position: 'absolute', bottom: 8, left: 10, right: 10 },
  file: {
    flexDirection: 'row', alignItems: 'center', width: 290, borderRadius: t.radius.lg,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
  },
  fileMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10 },
  fileIcon: { width: 42, height: 46, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.surfaceSunken, gap: 1 },
  fileExt: { fontFamily: t.fonts.bold, fontSize: 9, color: t.colors.textSecondary },
  fileName: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.text },
  fileSize: { ...t.type.caption, color: t.colors.textSecondary },
  fileShare: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
}));
