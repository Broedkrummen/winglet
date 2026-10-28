import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ListGroup, ListRow, SectionHeader } from '../../components/ui';
import { api } from '../../lib/api';
import type { Server } from '../../lib/types';
import { routineHref, type RoutineDefinition } from './model';
/** Keeps deleted routines discoverable without changing the existing active Schedule list. */
export function ArchivedRoutineLinks({ server, revision }: { server: Server; revision?: unknown }) {
  const [items, setItems] = useState<RoutineDefinition[]>([]);
  useEffect(() => {
    let active = true; setItems([]);
    api<{ archived: RoutineDefinition[] }>(server, '/api/routine-history').then(d => { if (active) setItems(d.archived); }).catch(() => {});
    return () => { active = false; };
  }, [server, revision]);
  if (!items.length) return null;
  return <View><SectionHeader title="Past routines" /><ListGroup>{items.map(r => <ListRow key={r.id}
    title={r.name || r.id} value="Removed" onPress={() => router.push(routineHref(server.id, r.id) as any)}/>)}</ListGroup></View>;
}
