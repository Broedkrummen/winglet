import { useRef, useState } from 'react';
import { View } from 'react-native';
import { homeChat, useApp } from '../lib/store';
import type { Server } from '../lib/types';
import { Composer } from './Composer';
import { LivePet } from './LivePet';
import { Sheet } from './Sheet';

/** Ask the main bot from anywhere: its pet, and the same message box as its main chat. Sending closes it. */
export function QuickAsk({ server, visible, onClose }: { server: Server; visible: boolean; onClose: () => void }) {
  const chatId = useApp((st) => homeChat(st.runtime[server.id]));
  const busy = useApp((st) => !!st.runtime[server.id]?.typing[chatId]);
  const target = useRef<View>(null);
  const [height, setHeight] = useState(64);
  return (
    <Sheet visible={visible} onClose={onClose} title={`Ask ${server.bot.title}`}>
      <View ref={target} style={{ alignItems: 'center', paddingVertical: 8 }}>
        <LivePet server={server} size={72} glow />
      </View>
      <View style={{ height }}>
        <Composer server={server} chatId={chatId} busy={busy} bottomInset={0} target={target} onHeight={setHeight}
          placeholder={`Message ${server.bot.title}`} onSent={onClose} />
      </View>
    </Sheet>
  );
}
