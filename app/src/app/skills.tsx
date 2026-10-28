import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { JobSheet } from '../components/JobSheet';
import { Download, Search, Trash2 } from '../components/icons';
import { Markdown } from '../components/Markdown';
import { Screen } from '../components/Screen';
import { withSelectedServer } from '../components/ServerScreen';
import { Sheet } from '../components/Sheet';
import { Button, ConfirmButton, Footnote, ListGroup, ListRow, LoadError, SearchField, SectionHeader, Segmented, Skeleton, Toggle } from '../components/ui';
import { byCategory, categoryLabel, matches } from '../lib/abilities';
import { api, ApiError, signedApi } from '../lib/api';
import { idempotencyKey } from '../lib/control';
import { haptic } from '../lib/haptics';
import { spring, useReducedMotion } from '../lib/motion';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { CatalogSkill, Job, Server, Skill } from '../lib/types';

const ORIGIN: Record<Skill['provenance'], string> = { bundled: 'Comes with Hermes', hub: 'Installed', agent: 'Agent or you' };
const rise = (reduced: boolean, i: number) => (reduced || i > 8 ? undefined
  : FadeIn.duration(180));

/** What your agent knows how to do: turn skills on and off, read them, and add Hermes's official ones. */
export default withSelectedServer(SkillsScreen);

function SkillsScreen() {
  const s = useStyles();
  const reduced = useReducedMotion();
  const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
  const [tab, setTab] = useState<'installed' | 'add'>('installed');
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogSkill[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Skill | CatalogSkill | null>(null);
  const [job, setJob] = useState<Job | null>(null);

  const load = useCallback(() => {
    if (!server) return;
    return Promise.all([
      api<{ skills: Skill[] }>(server, '/api/skills').then((d) => { setSkills(d.skills); setError(''); })
        .catch((e) => setError((e as Error).message)),
      api<{ skills: CatalogSkill[] }>(server, '/api/skills/catalog').then((d) => setCatalog(d.skills)).catch(() => setCatalog([])),
    ]);
  }, [server]);
  useEffect(() => { load(); }, [load]);

  const installedGroups = useMemo(() => byCategory((skills ?? []).filter((x) => matches(query, x.name, x.description, x.category))), [skills, query]);
  const catalogGroups = useMemo(() => byCategory((catalog ?? []).filter((x) => matches(query, x.name, x.description, x.category, x.tags))), [catalog, query]);
  if (!server) return null;

  const toggle = async (skill: Skill, enabled: boolean) => {
    setSkills((list) => (list ?? []).map((x) => (x.name === skill.name ? { ...x, enabled } : x)));
    try {
      await signedApi(server, 'PUT', `/api/skills/${encodeURIComponent(skill.name)}`, { enabled });
    } catch (e) {
      setSkills((list) => (list ?? []).map((x) => (x.name === skill.name ? { ...x, enabled: !enabled } : x)));
      haptic.error();
      useApp.getState().toast({ serverId: server.id, title: "Couldn't change that", body: (e as Error).message });
    }
  };
  const start = async (method: 'POST' | 'DELETE', path: string, body?: object) => {
    try {
      const r = await signedApi<{ job: Job }>(server, method, path, { ...body, idempotency_key: idempotencyKey() });
      setOpen(null);
      setJob(r.job);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.job) { setOpen(null); setJob(e.data.job as Job); return; }
      haptic.error();
      useApp.getState().toast({ serverId: server.id, title: "Couldn't start that", body: (e as Error).message });
    }
  };

  const enabled = (skills ?? []).filter((x) => x.enabled).length;
  return (
    <Screen title="Skills"
      onRefresh={load}>
      <View style={{ marginTop: 18, gap: 12 }}>
        <Segmented label="Show" value={tab} onChange={setTab} options={[
          { value: 'installed', label: skills ? `Installed (${skills.length})` : 'Installed' },
          { value: 'add', label: 'Add more' },
        ]} />
        <SearchField value={query} onChangeText={setQuery} placeholder={tab === 'installed' ? 'Search your skills' : 'Search official skills'} />
      </View>
      {error && skills ? <Text style={s.error}>{error}</Text> : null}

      {tab === 'installed' ? (
        !skills ? (error ? <LoadError message={error} onRetry={load} /> : <Loading />) : (
          <View>
            <Footnote>{enabled} of {skills.length} enabled for new chats.</Footnote>
            {installedGroups.map((g, gi) => (
              <Animated.View key={g.title} entering={rise(reduced, gi)}>
                <SectionHeader title={g.title} />
                <ListGroup>
                  {g.items.map((x) => (
                    <ListRow key={x.name} title={x.name} value={x.usage ? `${x.usage} uses` : undefined} onPress={() => setOpen(x)} chevron={false}
                      right={<Toggle label={`${x.name} skill`} value={x.enabled} onValueChange={(on) => toggle(x, on)} />} />
                  ))}
                </ListGroup>
              </Animated.View>
            ))}
            {!installedGroups.length ? <NoMatch query={query} /> : null}
          </View>
        )
      ) : !catalog ? <Loading /> : (
        <View>
          <Footnote>Official skills from Hermes.</Footnote>
          {catalogGroups.map((g, gi) => (
            <Animated.View key={g.title} entering={rise(reduced, gi)}>
              <SectionHeader title={g.title} />
              <ListGroup>
                {g.items.map((x) => (
                  <ListRow key={x.identifier} title={x.name} onPress={() => setOpen(x)} chevron={false}
                    right={x.installed ? <Text style={s.installed}>Installed</Text>
                      : <Button size="sm" variant="tonal" title="Install" onPress={() => start('POST', '/api/skills/install', { identifier: x.identifier })} />} />
                ))}
              </ListGroup>
            </Animated.View>
          ))}
          {!catalogGroups.length ? <NoMatch query={query} /> : null}
        </View>
      )}

      {/* The open skill as the list has it now, so a toggle that fails and rolls back shows in the sheet too. */}
      <SkillSheet server={server} item={open && isSkill(open) ? skills?.find((x) => x.name === open.name) ?? open : open} onClose={() => setOpen(null)}
        onToggle={(x, on) => toggle(x, on)}
        onInstall={(x) => start('POST', '/api/skills/install', { identifier: x.identifier })}
        onRemove={(x) => start('DELETE', `/api/skills/${encodeURIComponent(x.name)}`)} />
      <JobSheet server={server} job={job} onClose={() => setJob(null)} onDone={load} />
    </Screen>
  );
}

function Loading() {
  const t = useTheme();
  return <View style={{ gap: 10, marginTop: 20 }}>{[0, 1, 2].map((i) => <Skeleton key={i} height={64} radius={t.radius.lg} />)}</View>;
}

function NoMatch({ query }: { query: string }) {
  const t = useTheme();
  const s = useStyles();
  return (
    <View style={s.empty}>
      <View style={s.emptyIcon}><Search size={24} color={t.colors.textSecondary} /></View>
      <Text style={s.emptyText}>{query ? `Nothing matches "${query}".` : 'Nothing here yet.'}</Text>
    </View>
  );
}

const isSkill = (x: Skill | CatalogSkill): x is Skill => 'provenance' in x;

/** A skill's own instructions (its SKILL.md), with what you can do with it. */
function SkillSheet({ server, item, onClose, onToggle, onInstall, onRemove }: {
  server: Server; item: Skill | CatalogSkill | null; onClose: () => void; onToggle: (x: Skill, on: boolean) => void;
  onInstall: (x: CatalogSkill) => void; onRemove: (x: Skill) => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const { height } = useWindowDimensions();
  const [last, setLast] = useState<Skill | CatalogSkill | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  if (item && item !== last) { setLast(item); if (!last || last.name !== item.name) { setContent(null); setTruncated(false); } }
  const x = item ?? last;

  useEffect(() => {
    if (!item || !isSkill(item)) return;
    let live = true;
    api<{ content: string; truncated?: boolean }>(server, `/api/skills/${encodeURIComponent(item.name)}/content`)
      .then((d) => { if (live) { setContent(d.content.replace(/^---\n[\s\S]*?\n---\n/, '').trim()); setTruncated(!!d.truncated); } })
      .catch(() => { if (live) setContent(''); });
    return () => { live = false; };
  }, [item?.name, server]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!x) return null;
  return (
    <Sheet visible={!!item} onClose={onClose} title={x.name}>
      <View style={{ gap: 14, paddingHorizontal: 4 }}>
        <ListGroup>
          <ListRow title="Category" value={categoryLabel(x.category)} />
          <ListRow title="Source" value={isSkill(x) ? ORIGIN[x.provenance] : 'Official'} />
        </ListGroup>
        <Text style={s.description}>{x.description}</Text>
        {isSkill(x) ? (
          <>
            <ScrollView style={[s.doc, { maxHeight: height * 0.42 }]} contentContainerStyle={{ padding: 14 }} nestedScrollEnabled>
              {content === null ? <ActivityIndicator color={t.colors.textTertiary} />
                : content ? <Markdown text={content} /> : <Text style={s.metaText}>No instructions to show.</Text>}
              {truncated ? <Text style={[s.metaText, { marginTop: 10 }]}>Showing the first part. The whole skill is on the server.</Text> : null}
            </ScrollView>
            {x.provenance === 'hub' ? (
              <ConfirmButton title="Remove from server" icon={<Trash2 size={16} color={t.colors.danger} />} onConfirm={() => onRemove(x)}
                accessibilityLabel={`Remove ${x.name} from the server`} />
            ) : null}
            <ListGroup>
              <ListRow title="Use this skill" subtitle="Applies to new chats"
                right={<Toggle label={`${x.name} skill`} value={x.enabled} onValueChange={(on) => onToggle(x, on)} />} />
            </ListGroup>
          </>
        ) : x.installed ? (
          <Text style={s.metaText}>Already installed. Find it under Installed.</Text>
        ) : (
          <Button title="Install" icon={<Download size={16} color={t.colors.onAccent} />} onPress={() => onInstall(x)} />
        )}
      </View>
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  error: { ...t.type.callout, color: t.colors.danger, marginTop: 10 },
  installed: { ...t.type.caption, color: t.colors.textTertiary },
  empty: { alignItems: 'center', gap: t.space.md, paddingVertical: t.space.xxl },
  emptyIcon: { width: 56, height: 56, borderRadius: t.radius.pill, backgroundColor: t.colors.surfaceSunken, alignItems: 'center', justifyContent: 'center' },
  emptyText: { ...t.type.callout, color: t.colors.textSecondary },
  metaText: { ...t.type.caption, color: t.colors.textSecondary },
  description: { ...t.type.callout, color: t.colors.text },
  doc: { borderRadius: t.radius.lg, backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border },
}));
