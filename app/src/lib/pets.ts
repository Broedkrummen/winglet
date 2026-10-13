// Row and frame rules follow Hermes Desktop's pet-sprite.tsx (apps/desktop/src/components/pet).
// Copyright (c) 2025 Nous Research. MIT License: https://github.com/NousResearch/hermes-agent/blob/main/LICENSE
import type { PetSheet } from './types';

/** The animations a pet has. Hermes's names; newer petdex sheets call some rows waving, jumping, running. */
export type PetState = 'idle' | 'wave' | 'run' | 'waiting' | 'review' | 'jump' | 'failed';

export const PET_STATES: { state: PetState; label: string }[] = [
  { state: 'idle', label: 'Resting' }, { state: 'wave', label: 'Replied' }, { state: 'run', label: 'Working' },
  { state: 'waiting', label: 'Needs you' }, { state: 'review', label: 'Thinking' }, { state: 'jump', label: 'Done' },
  { state: 'failed', label: 'Oops' },
];

/** How long the pet waves after a reply lands, as in Hermes. */
export const WAVE_MS = 2500;

/**
 * What the pet shows, in Hermes's order (agent/pet/state.py) for the signals the app has: a reply that
 * just landed beats waiting on you, which beats working.
 */
export function petState(s: { replied?: boolean; waiting?: boolean; working?: boolean }): PetState {
  if (s.replied) return 'wave';
  if (s.waiting) return 'waiting';
  if (s.working) return 'run';
  return 'idle';
}

const ROW_NAMES: Record<PetState, string[]> = {
  idle: ['idle'], wave: ['wave', 'waving'], run: ['run', 'running'], waiting: ['waiting'], review: ['review'],
  jump: ['jump', 'jumping'], failed: ['failed'],
};

function rowOf(sheet: PetSheet, state: PetState): number {
  for (const name of ROW_NAMES[state]) {
    const row = sheet.state_rows.indexOf(name);
    if (row >= 0 && row < sheet.rows) return row;
  }
  return 0;
}

function framesOf(sheet: PetSheet, state: PetState): number {
  return Math.min(sheet.columns, sheet.frames[state] ?? sheet.frames_per_state);
}

/** The sheet row a state draws from and its frame count. A state the sheet left empty shows idle instead. */
export function petFrames(sheet: PetSheet, state: PetState): { row: number; count: number } {
  const count = framesOf(sheet, state);
  if (count > 0) return { row: rowOf(sheet, state), count };
  return { row: rowOf(sheet, 'idle'), count: Math.max(1, framesOf(sheet, 'idle')) };
}

/** A frame's on-screen size for a height, in whole pixels so neighbouring frames never show at the edges. */
export function petBox(sheet: Pick<PetSheet, 'frame_w' | 'frame_h'>, height: number): { width: number; height: number } {
  const h = Math.max(1, Math.round(height));
  return { width: Math.max(1, Math.round((h * sheet.frame_w) / sheet.frame_h)), height: h };
}
