import { create } from 'zustand';

/** What a refused owner action says when the fix is to verify this phone (the sheet explains how). */
export const NEEDS_VERIFY = 'Verify this phone to do that.';

type State = {
  /** The bot asking this phone to verify, while the sheet is open. */
  serverId: string | null;
  ask: (serverId: string) => void;
  close: () => void;
};

/** Opens the one "Verify this phone" sheet, whichever screen's action needed it. */
export const useVerify = create<State>((set) => ({
  serverId: null,
  ask: (serverId) => set({ serverId }),
  close: () => set({ serverId: null }),
}));
