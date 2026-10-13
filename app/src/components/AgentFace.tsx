import { useEffect, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { moodOf, pendingItems, workingChats } from '../lib/agent';
import { mediaUrl } from '../lib/api';
import { petState, WAVE_MS, type PetState } from '../lib/pets';
import { useApp } from '../lib/store';
import type { Server } from '../lib/types';
import { BotAvatar, type Mood } from './BotAvatar';
import { PetSprite } from './PetSprite';

type Props = {
  server: Server;
  size: number;
  /** A hero placement: the orb gets its halo, the pet is drawn a little larger. */
  glow?: boolean;
  /** Whether the orb moves. A pet always does (it's what pets are for), unless motion is reduced. */
  animated?: boolean;
  /** Show this instead of what the agent is doing (the typing row is always working). */
  mood?: Mood;
  style?: StyleProp<ViewStyle>;
};

const MOOD_STATE: Record<Mood, PetState> = { idle: 'idle', working: 'run', waiting: 'waiting', happy: 'wave', offline: 'idle' };

/** The agent's live face: its pet when it has one, its orb otherwise. Both show what it's doing. */
export function AgentFace({ server, size, glow, animated = false, mood, style }: Props) {
  const rt = useApp((st) => st.runtime[server.id]);
  const pet = rt?.pet;
  const lastReply = rt?.lastReplyAt ?? 0;
  const replied = Date.now() - lastReply < WAVE_MS;
  const [, wake] = useState(0);
  // Back to idle when the wave is over, even if nothing else changes.
  useEffect(() => {
    if (!pet || !replied) return;
    const id = setTimeout(() => wake((n) => n + 1), lastReply + WAVE_MS - Date.now() + 50);
    return () => clearTimeout(id);
  }, [pet, replied, lastReply]);

  if (!pet) return <BotAvatar name={server.bot.name} size={size} mood={mood ?? moodOf(rt)} animated={animated} glow={glow} style={style} />;
  const online = rt?.status === 'online';
  const state = mood ? MOOD_STATE[mood] : petState({ replied, waiting: pendingItems(rt).length > 0, working: workingChats(rt).length > 0 });
  return (
    <View style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center', opacity: online ? 1 : 0.5 }, style]}>
      <PetSprite sheet={pet} uri={mediaUrl(server, pet.sheet_url)} height={size * (glow ? 1.35 : 1.15)} state={state}
        still={!online} />
    </View>
  );
}
