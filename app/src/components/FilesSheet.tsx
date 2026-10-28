import { Image } from 'expo-image';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Platform, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { agoText } from '../lib/agent';
import { api, mediaUrl } from '../lib/api';
import { bytes } from '../lib/control';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { ChatFile, Server } from '../lib/types';
import { FileText, Mic, Video } from './icons';
import { MediaViewer, type ViewerItem } from './MediaViewer';
import { Sheet } from './Sheet';
import { Segmented, Tap } from './ui';

/** Everything shared in a chat, both ways: photos as a grid, everything else as a list. */
export function FilesSheet({ server, chatId, visible, onClose, onJump }: {
  server: Server; chatId: string; visible: boolean; onClose: () => void; onJump: (messageId: string) => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const { width } = useWindowDimensions();
  const [files, setFiles] = useState<ChatFile[] | null>(null);
  const [tab, setTab] = useState<'photos' | 'files'>('photos');
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    if (!visible) return;
    setFiles(null);
    api<{ files: ChatFile[] }>(server, `/api/chats/${encodeURIComponent(chatId)}/files`)
      .then((d) => { setFiles(d.files); if (!d.files.some((f) => f.kind === 'image')) setTab('files'); })
      .catch(() => setFiles([]));
  }, [visible, server, chatId]);

  const photos = useMemo(() => (files ?? []).filter((f) => f.kind === 'image'), [files]);
  const others = useMemo(() => (files ?? []).filter((f) => f.kind !== 'image'), [files]);
  const viewer: ViewerItem[] = useMemo(() => photos.map((f) => ({ uri: mediaUrl(server, f.url), name: f.name })), [photos, server]);
  const cell = Math.floor((Math.min(width, 560) - 32 - 8 * 2) / 3);
  const openFile = (f: ChatFile) => {
    const uri = mediaUrl(server, f.url);
    if (Platform.OS === 'web') globalThis.open?.(uri, '_blank', 'noopener');
    else Linking.openURL(uri);
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Files and photos">
      <View style={{ gap: 14, paddingHorizontal: 4 }}>
        <Segmented label="Show" value={tab} onChange={setTab}
          options={[{ value: 'photos', label: `Photos${photos.length ? ` · ${photos.length}` : ''}` }, { value: 'files', label: `Files${others.length ? ` · ${others.length}` : ''}` }]} />
        {files === null ? <ActivityIndicator color={t.colors.accent} style={{ marginVertical: 32 }} /> : (
          <ScrollView style={{ maxHeight: 440 }} contentContainerStyle={{ paddingBottom: 8 }}>
            {tab === 'photos' ? (
              photos.length ? (
                <View style={s.grid}>
                  {photos.map((f, i) => (
                    <Tap key={`${f.url}-${i}`} feedback="light" scaleTo={0.96} onPress={() => setOpen(i)}
                      accessibilityLabel={`Photo ${f.name}, ${f.role === 'bot' ? 'from your bot' : 'sent by you'}, ${agoText(f.created_at)}`}
                      style={[s.cell, { width: cell, height: cell }]}>
                      <Image source={{ uri: mediaUrl(server, f.url) }} style={{ width: '100%', height: '100%' }} contentFit="cover" transition={150}
                        accessibilityIgnoresInvertColors />
                    </Tap>
                  ))}
                </View>
              ) : <Text style={s.empty}>No photos in this chat yet.</Text>
            ) : others.length ? (
              <View style={{ gap: t.space.sm }}>
                {others.map((f, i) => (
                  <Tap key={`${f.url}-${i}`} feedback="selection" onPress={() => openFile(f)} onLongPress={() => { onClose(); onJump(f.message_id); }}
                    accessibilityLabel={`${f.name}, ${bytes(f.size)}. Open. Long-press to find it in the chat`}
                    scaleTo={0.98} style={({ hovered, pressed }) => [s.file, (hovered || pressed) && { borderColor: t.colors.borderStrong }]}>
                    <View style={s.fileIcon}>
                      {f.kind === 'video' ? <Video size={18} color={t.colors.textSecondary} />
                        : f.kind === 'voice' || f.kind === 'audio' ? <Mic size={18} color={t.colors.textSecondary} />
                          : <FileText size={18} color={t.colors.textSecondary} />}
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={s.fileName} numberOfLines={1}>{f.kind === 'voice' ? 'Voice message' : f.name}</Text>
                      <Text style={s.fileMeta}>{bytes(f.size)} · {f.role === 'bot' ? 'from your bot' : 'you'} · {agoText(f.created_at)}</Text>
                    </View>
                  </Tap>
                ))}
              </View>
            ) : <Text style={s.empty}>No files in this chat yet.</Text>}
          </ScrollView>
        )}
      </View>
      <MediaViewer items={viewer} index={open} onClose={() => setOpen(null)} />
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { borderRadius: t.radius.md, overflow: 'hidden', backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border },
  empty: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center', marginVertical: 28 },
  file: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: t.space.md, minHeight: 64, borderRadius: t.radius.lg, backgroundColor: t.colors.surface,
    borderWidth: 1, borderColor: t.colors.border,
  },
  fileIcon: { width: 40, height: 40, borderRadius: t.radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.surfaceSunken },
  fileName: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.text },
  fileMeta: { ...t.type.caption, color: t.colors.textSecondary, marginTop: 2 },
}));
