import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { moodOf } from '../lib/agent';
import { mediaUrl } from '../lib/api';
import { avatarColor, petState, WAVE_MS, type PetState } from '../lib/pets';
import { useApp } from '../lib/store';
import { BOT_COLORS } from '../lib/theme';
import { useTheme } from '../lib/themeContext';
import type { Server } from '../lib/types';
import { BotAvatar, shade, type Mood } from './BotAvatar';
import { PetSprite } from './PetSprite';

type Props = {
  server: Server;
  size: number;
  /** A hero placement: a halo behind the bot, and the pet drawn larger, out of any frame. */
  glow?: boolean;
  /** Whether the orb moves. A pet moves too, unless `still` (or motion is reduced). */
  animated?: boolean;
  /** Hold a pet on its first frame: for avatars in lists, where dozens of moving pets would only distract. */
  still?: boolean;
  /** Show this instead of what the agent is doing (the typing row is always working). */
  mood?: Mood;
  status?: 'online' | 'offline' | 'connecting' | 'busy';
  shape?: 'circle' | 'squircle';
  style?: StyleProp<ViewStyle>;
};

const MOOD_STATE: Record<Mood, PetState> = { idle: 'idle', working: 'run', waiting: 'waiting', happy: 'wave', offline: 'idle' };

/** The colour behind a bot's avatar and Home's glow: its pet's when it has one, the one it was made with otherwise. */
export function useAvatarColor(server: Server): string {
  return useApp((st) => avatarColor(BOT_COLORS, server.bot.name, st.runtime[server.id]?.pet));
}

/**
 * The bot's face, everywhere one appears: its pet when it has one, its orb otherwise. Both show what it's
 * doing, and a pet sits on a gradient of its own colour, not the colour the bot was made with.
 */
export function AgentFace({ server, size, glow, animated = false, still, mood, status, shape = 'circle', style }: Props) {
  const t = useTheme();
  const pet = useApp((st) => st.runtime[server.id]?.pet);
  const online = useApp((st) => st.runtime[server.id]?.status === 'online');
  const live = useApp((st) => moodOf(st.runtime[server.id]));
  const lastReply = useApp((st) => st.runtime[server.id]?.lastReplyAt ?? 0);
  const replied = Date.now() - lastReply < WAVE_MS;
  const [, wake] = useState(0);
  // Back to idle when the wave is over, even if nothing else changes.
  useEffect(() => {
    if (!pet || !replied) return;
    const id = setTimeout(() => wake((n) => n + 1), lastReply + WAVE_MS - Date.now() + 50);
    return () => clearTimeout(id);
  }, [pet, replied, lastReply]);

  if (!pet) {
    return <BotAvatar name={server.bot.name} size={size} mood={mood ?? live} animated={animated} glow={glow} status={status} shape={shape} style={style} />;
  }

  const color = avatarColor(BOT_COLORS, server.bot.name, pet);
  const state = mood ? MOOD_STATE[mood] : petState({ replied, waiting: live === 'waiting', working: live === 'working' });
  const sprite = (height: number) => (
    <PetSprite sheet={pet} uri={mediaUrl(server, pet.sheet_url)} height={height} state={state} still={!online || still} />
  );
  const dot = status ? { online: t.colors.success, busy: t.colors.warning, connecting: t.colors.warning, offline: t.colors.textTertiary }[status] : null;
  const dotSize = Math.max(10, size * 0.3);
  const statusDot = dot ? (
    <View style={{ position: 'absolute', right: -1, bottom: -1, width: dotSize, height: dotSize, borderRadius: dotSize,
      backgroundColor: dot, borderWidth: Math.max(2, size * 0.07), borderColor: t.colors.bg }} />
  ) : null;

  if (glow) {
    return (
      <View style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center', opacity: online ? 1 : 0.5 }, style]}>
        <View pointerEvents="none" style={{
          position: 'absolute', left: size * 0.1, top: size * 0.1, width: size * 0.8, height: size * 0.8, borderRadius: size, opacity: 0.55,
          backgroundColor: color, boxShadow: `0 0 ${size * 0.55}px ${size * 0.18}px ${color}`,
        } as ViewStyle} />
        {sprite(size * 1.35)}
        {statusDot}
      </View>
    );
  }
  return (
    <View style={[{ width: size, height: size }, style]}>
      <LinearGradient
        colors={[shade(color, 0.32), color, shade(color, -0.18)]}
        locations={[0, 0.55, 1]}
        start={{ x: 0.15, y: 0 }}
        end={{ x: 0.85, y: 1 }}
        style={{ width: size, height: size, borderRadius: shape === 'squircle' ? size * 0.32 : size / 2, overflow: 'hidden',
          alignItems: 'center', justifyContent: 'center', opacity: online ? 1 : 0.55 }}
      >
        {sprite(size * 0.9)}
      </LinearGradient>
      {statusDot}
    </View>
  );
}
