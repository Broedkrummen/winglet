/** The three checkpoint calls, on the app's usual authenticated and signed transports. */

import { api, signedApi } from '../../lib/api';
import type { Server } from '../../lib/types';
import type { CheckpointList, CheckpointPreview, RestoreOutcome, RestoreRequest } from './types';

// A hash is only ever eight-ish lowercase hex characters from the list; anything else never leaves here.
const HASH = /^[0-9a-f]{4,64}$/;

function hashOf(value: string): string {
  const hash = String(value || '').toLowerCase();
  if (!HASH.test(hash)) throw new Error('That checkpoint is no longer available.');
  return hash;
}

export function listCheckpoints(server: Server): Promise<CheckpointList> {
  return api<CheckpointList>(server, '/api/checkpoints');
}

export function previewCheckpoint(server: Server, hash: string): Promise<CheckpointPreview> {
  return api<CheckpointPreview>(server, `/api/checkpoints/${hashOf(hash)}`);
}

/** A signed owner action that Hermes performs on the server; never queued for later. */
export async function restoreCheckpoint(server: Server, hash: string, request: RestoreRequest): Promise<RestoreOutcome> {
  const answer = await signedApi<{ result: RestoreOutcome }>(
    server, 'POST', `/api/checkpoints/${hashOf(hash)}/restore`, request);
  return answer.result;
}
