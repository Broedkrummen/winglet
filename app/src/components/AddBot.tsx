import { router } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { isOwner, useApp } from '../lib/store';
import { useTheme } from '../lib/themeContext';
import type { Server } from '../lib/types';
import { Bot, QrCode, Smartphone } from './icons';
import { Sheet } from './Sheet';
import { ListGroup, ListRow } from './ui';

/**
 * The server a new bot would live on (the selected bot's, whichever of its bots is selected) and whether
 * this phone may make one there: the plugin supports it and the phone is an owner.
 */
export function useBotHost(): { main?: Server; canMake: boolean } {
  const main = useApp((st) => {
    const selected = st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0];
    return selected?.parent ? st.servers.find((x) => x.id === selected.parent) : selected;
  });
  const rt = useApp((st) => (main ? st.runtime[main.id] : undefined));
  return { main, canMake: !!main && !!rt?.info?.features?.bots && isOwner(rt) };
}

/** Ways to bring in a bot that already exists on another Hermes server. Every "add a bot" screen offers these. */
export function PairRows({ onPick }: { onPick?: () => void }) {
  const t = useTheme();
  const go = (path: '/scan' | '/pair') => () => { onPick?.(); router.push(path); };
  return (
    <ListGroup>
      {Platform.OS !== 'web' ? (
        <ListRow icon={<QrCode size={18} color={t.colors.onAccentSoft} />} title="Scan a QR code"
          subtitle="From `hermes winglet pair` on the other server" onPress={go('/scan')} />
      ) : null}
      <ListRow icon={<Smartphone size={18} color={t.colors.onAccentSoft} />} title="Pair with a code"
        subtitle="Type the address and code instead" onPress={go('/pair')} />
    </ListGroup>
  );
}

/**
 * "Add a bot", the same from every place that offers it: make a new bot on this server, or scan a code to
 * bring one in from another. Use the hook, render `sheet` once, call `open`.
 */
export function useAddBot(): { open: () => void; sheet: ReactNode } {
  const t = useTheme();
  const { canMake, main } = useBotHost();
  const [visible, setVisible] = useState(false);
  const open = useCallback(() => setVisible(true), []);
  const close = () => setVisible(false);
  const sheet = (
    <Sheet visible={visible} onClose={close} title="Add a bot" scrollable>
      <ListGroup style={{ marginBottom: 12 }}>
        <ListRow icon={<Bot size={18} color={canMake ? t.colors.success : t.colors.textTertiary} />} iconColor={canMake ? t.colors.success : undefined}
          title="Create a new bot"
          subtitle={canMake ? `A new agent on ${main?.bot.title}'s server, with its own persona, memory and pet`
            : 'Needs an owner phone and the latest Winglet plugin on this server'}
          chevron={canMake} disabled={!canMake} onPress={canMake ? () => { close(); router.push('/new-bot'); } : () => undefined} />
      </ListGroup>
      <PairRows onPick={close} />
    </Sheet>
  );
  return { open, sheet };
}
