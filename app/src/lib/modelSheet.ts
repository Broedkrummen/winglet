import { create } from 'zustand';

/** Waiting on the reasoning card the model sheet asked Hermes for, so the chat doesn't show it too. */
export type SheetSlot = { before: string[]; claimed?: string; until: number };

type SheetState = {
  slots: Record<string, SheetSlot | undefined>;
  ask: (key: string, before: string[], seconds?: number) => void;
  claim: (key: string, messageId: string) => void;
  clear: (key: string) => void;
};

export const useModelSheet = create<SheetState>((set) => ({
  slots: {},
  ask: (key, before, seconds = 12) => set((s) => ({ slots: { ...s.slots, [key]: { before, until: Date.now() + seconds * 1000 } } })),
  claim: (key, messageId) => set((s) => (s.slots[key] ? { slots: { ...s.slots, [key]: { ...s.slots[key]!, claimed: messageId } } } : s)),
  clear: (key) => set((s) => ({ slots: { ...s.slots, [key]: undefined } })),
}));
