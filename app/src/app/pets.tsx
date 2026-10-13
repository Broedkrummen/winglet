import { Image } from 'expo-image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { BotAvatar } from '../components/BotAvatar';
import { Check, Download, PawPrint, Search, Trash2 } from '../components/icons';
import { JobSheet } from '../components/JobSheet';
import { PetSprite } from '../components/PetSprite';
import { Screen } from '../components/Screen';
import { Sheet } from '../components/Sheet';
import { Button, Card, Chip, Field, ListGroup, ListRow, SectionHeader, Skeleton, Tap, Toggle } from '../components/ui';
import { api, ApiError, mediaUrl, signedApi } from '../lib/api';
import { idempotencyKey } from '../lib/control';
import { haptic } from '../lib/haptics';
import { PET_STATES, type PetState } from '../lib/pets';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { CatalogPet, InstalledPet, Job, PetList, Server } from '../lib/types';

const TILE_GAP = 10;

type Picked = { pet: InstalledPet | CatalogPet; installed: boolean };

/** The agent's pet: its animated face on every phone, picked from the petdex gallery. */
export default function PetsScreen() {
  const t = useTheme();
  const s = useStyles();
  const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
  const current = useApp((st) => (server ? st.runtime[server.id]?.pet : undefined));
  const [mine, setMine] = useState<PetList | null>(null);
  const [gallery, setGallery] = useState<{ total: number; pets: CatalogPet[] } | null>(null);
  const [galleryError, setGalleryError] = useState('');
  const [query, setQuery] = useState('');
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<PetState>('idle');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [width, setWidth] = useState(0);

  const loadMine = useCallback(() => {
    if (!server) return;
    api<PetList>(server, '/api/pets').then((d) => { setMine(d); setError(''); }).catch((e) => setError((e as Error).message));
  }, [server]);
  useEffect(loadMine, [loadMine]);

  const search = useRef(0);
  /** Resolves true while the server is still fetching the gallery from petdex. */
  const loadGallery = useCallback(async (q: string, offset: number): Promise<boolean> => {
    if (!server) return false;
    const mine = offset ? search.current : ++search.current;
    try {
      const d = await api<{ total: number; pets: CatalogPet[]; loading?: boolean }>(server,
        `/api/pets/catalog?q=${encodeURIComponent(q)}&offset=${offset}`);
      if (mine !== search.current) return false; // a newer search answered, or will
      if (d.loading) return true;
      setGallery((g) => (offset && g ? { total: d.total, pets: [...g.pets, ...d.pets] } : d));
      setGalleryError('');
    } catch (e) {
      if (mine !== search.current) return false;
      if (!offset) setGallery({ total: 0, pets: [] });
      setGalleryError((e as Error).message);
    }
    return false;
  }, [server]);
  useEffect(() => {
    let live = true;
    let id: ReturnType<typeof setTimeout>;
    const attempt = async (left: number) => {
      const loading = await loadGallery(query.trim(), 0);
      if (!live || !loading) return;
      if (left > 0) id = setTimeout(() => attempt(left - 1), 2000);
      else { setGallery({ total: 0, pets: [] }); setGalleryError("The gallery at petdex.dev is taking too long. Try again in a minute."); }
    };
    id = setTimeout(() => attempt(15), query ? 300 : 0);
    return () => { live = false; clearTimeout(id); };
  }, [query, loadGallery]);

  if (!server) return null;
  const refresh = () => {
    loadMine();
    loadGallery(query.trim(), 0);
    useApp.getState().loadPet(server.id);
  };
  const failed = (title: string, e: unknown) => {
    haptic.error();
    useApp.getState().toast({ serverId: server.id, title, body: (e as Error).message });
  };

  const adopt = async (slug: string) => {
    setBusy(true);
    try {
      const r = await signedApi<{ pet?: { name: string }; job?: Job }>(server, 'POST', `/api/pets/${encodeURIComponent(slug)}/adopt`,
        { idempotency_key: idempotencyKey() });
      setPicked(null);
      if (r.job) setJob(r.job);
      else { haptic.success(); setPreview('wave'); refresh(); }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.job) { setPicked(null); setJob(e.data.job as Job); return; }
      failed("Couldn't adopt that pet", e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (slug: string) => {
    setBusy(true);
    try {
      await signedApi(server, 'DELETE', `/api/pets/${encodeURIComponent(slug)}`);
      setPicked(null);
      refresh();
    } catch (e) {
      failed("Couldn't remove that pet", e);
    } finally {
      setBusy(false);
    }
  };
  const show = async (on: boolean) => {
    setMine((m) => (m ? { ...m, enabled: on } : m));
    try {
      await signedApi(server, 'PUT', '/api/pets/display', { enabled: on });
      refresh();
    } catch (e) {
      setMine((m) => (m ? { ...m, enabled: !on } : m));
      failed("Couldn't change that", e);
    }
  };

  const columns = width >= 520 ? 5 : width >= 380 ? 4 : 3;
  const tile = width ? Math.floor((width - TILE_GAP * (columns - 1)) / columns) : 0;
  const installed = mine?.pets ?? [];
  return (
    <Screen title="Pet" subtitle="Your agent's animated face. It shows what the agent is doing, on every phone paired with this bot.">
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        <Card style={s.stage}>
          {current ? (
            <Animated.View entering={FadeIn} style={{ alignItems: 'center', gap: 6 }}>
              <PetSprite sheet={current} uri={mediaUrl(server, current.sheet_url)} height={170} state={preview} />
              <Text style={s.petName}>{current.name}</Text>
            </Animated.View>
          ) : (
            <View style={{ alignItems: 'center', gap: 10 }}>
              <BotAvatar name={server.bot.name} size={88} animated glow />
              <Text style={s.note}>{mine && installed.length ? 'The pet is off. The orb shows instead.' : 'No pet yet. Pick one from the gallery below.'}</Text>
            </View>
          )}
          {current ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 2 }}>
              {PET_STATES.map((x) => <Chip key={x.state} label={x.label} selected={preview === x.state} onPress={() => setPreview(x.state)} />)}
            </ScrollView>
          ) : null}
        </Card>
        {error ? <Text style={s.error}>{error}</Text> : null}

        {installed.length ? (
          <ListGroup style={{ marginTop: 14 }}>
            <ListRow icon={<PawPrint size={18} color={t.colors.onAccentSoft} />} title="Show the pet" subtitle="Off shows the orb instead"
              right={<Toggle label="Show the pet" value={!!mine?.enabled} onValueChange={show} />} />
          </ListGroup>
        ) : null}

        {installed.length ? (
          <>
            <SectionHeader title={`On your server · ${installed.length}`} />
            <View style={s.grid}>
              {installed.map((p) => (
                <PetTile key={p.slug} server={server} name={p.name} thumb={p.thumb_url} size={tile}
                  active={!!mine?.enabled && mine.active === p.slug} onPress={() => setPicked({ pet: p, installed: true })} />
              ))}
            </View>
          </>
        ) : null}

        <SectionHeader title="Gallery" right={<Text style={s.credit}>petdex.dev</Text>} />
        <Field value={query} onChangeText={setQuery} placeholder="Search pets" autoCapitalize="none" autoCorrect={false}
          accessibilityLabel="Search the pet gallery" />
        {galleryError ? <Text style={s.error}>{galleryError}</Text> : null}
        {!gallery ? (
          <View style={{ marginTop: 12, gap: 10 }}>
            <Text style={s.caption}>Getting pets from petdex.dev. The first time can take a few seconds.</Text>
            <View style={s.grid}>{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} width={tile || 96} height={(tile || 96) + 24} radius={16} />)}</View>
          </View>
        ) : gallery.pets.length ? (
          <Animated.View entering={FadeIn}>
            <View style={[s.grid, { marginTop: 12 }]}>
              {gallery.pets.map((p) => (
                <PetTile key={p.slug} server={server} name={p.name} thumb={p.thumb_url} size={tile} installed={p.installed}
                  active={!!mine?.enabled && mine.active === p.slug} onPress={() => setPicked({ pet: p, installed: p.installed })} />
              ))}
            </View>
            {gallery.pets.length < gallery.total ? (
              <Button title={`Show more · ${gallery.total - gallery.pets.length} left`} variant="secondary" loading={more} style={{ marginTop: 14 }}
                onPress={async () => { setMore(true); await loadGallery(query.trim(), gallery.pets.length); setMore(false); }} />
            ) : null}
          </Animated.View>
        ) : !galleryError ? (
          <View style={s.empty}>
            <Search size={22} color={t.colors.textTertiary} />
            <Text style={s.note}>{query ? `No pets match "${query}".` : 'The gallery is empty.'}</Text>
          </View>
        ) : null}
        <Text style={s.footnote}>Pets come from petdex.dev, a public gallery made by its community. Your server downloads the one you pick.</Text>
      </View>

      <PetSheet server={server} picked={picked} busy={busy} active={!!mine?.enabled && mine.active === picked?.pet.slug}
        onClose={() => setPicked(null)} onAdopt={adopt} onRemove={remove} />
      <JobSheet server={server} job={job} onClose={() => setJob(null)}
        onDone={(j) => { if (j.state === 'succeeded') setPreview('wave'); refresh(); }} />
    </Screen>
  );
}

function PetTile({ server, name, thumb, size, active, installed, onPress }: {
  server: Server; name: string; thumb: string; size: number; active?: boolean; installed?: boolean; onPress: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  if (!size) return null;
  return (
    <Tap feedback="selection" onPress={onPress} accessibilityLabel={`${name}${active ? ', showing now' : installed ? ', on your server' : ''}`}
      style={{ width: size, gap: 6 }}>
      <View style={[s.thumb, { height: size }, active && { borderColor: t.colors.accent, borderWidth: 2 }]}>
        <PawPrint size={size / 4} color={t.colors.textTertiary} style={{ position: 'absolute' }} />
        <Image source={{ uri: mediaUrl(server, thumb) }} style={{ width: '82%', height: '82%' }} contentFit="contain" cachePolicy="disk"
          transition={150} accessibilityIgnoresInvertColors />
        {active ? <View style={s.check}><Check size={12} color={t.colors.onAccent} /></View> : null}
      </View>
      <Text style={s.tileName} numberOfLines={1}>{name}</Text>
    </Tap>
  );
}

/** One pet, with what you can do with it. */
function PetSheet({ server, picked, busy, active, onClose, onAdopt, onRemove }: {
  server: Server; picked: Picked | null; busy: boolean; active: boolean; onClose: () => void;
  onAdopt: (slug: string) => void; onRemove: (slug: string) => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const [last, setLast] = useState<Picked | null>(null);
  if (picked && picked !== last) setLast(picked);
  const x = picked ?? last;
  if (!x) return null;
  const { pet } = x;
  const by = 'by' in pet && pet.by ? `By ${pet.by}` : '';
  const about = 'description' in pet ? pet.description : '';
  return (
    <Sheet visible={!!picked} onClose={onClose} title={pet.name}>
      <View style={{ gap: 14, paddingHorizontal: 4 }}>
        <View style={[s.thumb, { height: 150, alignSelf: 'center', width: 150 }]}>
          <Image source={{ uri: mediaUrl(server, pet.thumb_url) }} style={{ width: '86%', height: '86%' }} contentFit="contain" cachePolicy="disk" />
        </View>
        {by || about ? <Text style={s.note}>{[about, by].filter(Boolean).join(' · ')}</Text> : null}
        {active ? (
          <Text style={[s.note, { color: t.colors.success }]}>This is your agent's pet now.</Text>
        ) : (
          <Button title={x.installed ? 'Make it the pet' : 'Adopt'} loading={busy}
            icon={x.installed ? <PawPrint size={16} color={t.colors.onAccent} /> : <Download size={16} color={t.colors.onAccent} />}
            onPress={() => onAdopt(pet.slug)} />
        )}
        {!x.installed ? <Text style={s.caption}>Your server downloads it from petdex.dev. Everyone paired with this bot sees it.</Text> : null}
        {x.installed ? (
          <Button title="Remove from server" variant="danger" disabled={busy} icon={<Trash2 size={16} color={t.colors.danger} />}
            onPress={() => onRemove(pet.slug)} />
        ) : null}
        {busy && x.installed ? <ActivityIndicator color={t.colors.textTertiary} /> : null}
      </View>
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  stage: { marginTop: 18, gap: 14, paddingVertical: 20, alignItems: 'stretch' },
  petName: { ...t.type.bodyStrong, color: t.colors.text },
  note: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center' },
  caption: { ...t.type.caption, color: t.colors.textSecondary, textAlign: 'center' },
  credit: { ...t.type.caption, color: t.colors.textTertiary },
  error: { ...t.type.callout, color: t.colors.danger, marginTop: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: TILE_GAP },
  thumb: { borderRadius: 16, backgroundColor: t.colors.surfaceSunken, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    borderWidth: 2, borderColor: 'transparent' },
  check: { position: 'absolute', top: 6, right: 6, width: 20, height: 20, borderRadius: 10, backgroundColor: t.colors.accentFill,
    alignItems: 'center', justifyContent: 'center' },
  tileName: { ...t.type.caption, color: t.colors.text, textAlign: 'center' },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 28 },
  footnote: { ...t.type.caption, color: t.colors.textTertiary, marginTop: 18, paddingHorizontal: 4 },
}));
