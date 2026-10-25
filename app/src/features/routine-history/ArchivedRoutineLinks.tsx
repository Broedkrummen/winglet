import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { SectionHeader, Tap } from '../../components/ui';
import { api } from '../../lib/api';
import { makeStyles } from '../../lib/themeContext';
import type { Server } from '../../lib/types';
import { routineHref, type RoutineDefinition } from './model';
/** Keeps deleted routines discoverable without changing the existing active Schedule list. */
export function ArchivedRoutineLinks({ server, revision }: { server: Server; revision?: unknown }) {
  const s = useStyles(); const [items, setItems] = useState<RoutineDefinition[]>([]);
  useEffect(() => {
    let active = true; setItems([]);
    api<{ archived: RoutineDefinition[] }>(server, '/api/routine-history').then(d => { if (active) setItems(d.archived); }).catch(() => {});
    return () => { active = false; };
  }, [server, revision]);
  if (!items.length) return null;
  return <View><SectionHeader title="Past routines" /><View style={s.rows}>{items.map(r => <Tap key={r.id}
    accessibilityLabel={`View retained history for ${r.name || r.id}`} style={s.row} onPress={() => router.push(routineHref(server.id, r.id) as any)}>
    <Text style={s.rowTitle}>{r.name || r.id}</Text><Text style={s.caption}>Removed · retained run history</Text>
  </Tap>)}</View></View>;
}

const useStyles = makeStyles(t => ({ rows:{ borderTopWidth:1,borderColor:t.colors.border },row:{paddingVertical:16,gap:6,minHeight:60,borderBottomWidth:1,borderColor:t.colors.border}, rowTitle:{...t.type.bodyStrong,color:t.colors.text},caption:{...t.type.caption,color:t.colors.textTertiary} }));
