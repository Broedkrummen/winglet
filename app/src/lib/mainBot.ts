import { resolveMainBot } from './bots';
import { usePrefs } from './prefs';
import { useApp } from './store';
import type { Server } from './types';

/** The main bot, whichever the phone chose or the first one paired. */
export function useMainBot(): Server | undefined {
  const servers = useApp((st) => st.servers);
  const chosen = usePrefs((st) => st.prefs.mainBot);
  return resolveMainBot(servers, chosen);
}

export function setMainBot(serverId: string) {
  usePrefs.getState().update({ mainBot: serverId });
}
