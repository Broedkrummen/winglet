const retiring = new Set<string>();
const key = (serverId: string, uploadId: string) => JSON.stringify([serverId, uploadId]);

/** Keep local admission out of an explicitly reviewed file-release operation. */
export function beginUploadRetirement(serverIds: string[], uploadId: string): () => void {
  const keys = serverIds.map(serverId => key(serverId, uploadId));
  if (keys.some(value => retiring.has(value))) throw new Error('This retained file is already being released. Wait and refresh.');
  keys.forEach(value => retiring.add(value));
  return () => keys.forEach(value => retiring.delete(value));
}

export function assertUploadsAvailable(serverId: string, uploads: { id?: string }[]) {
  if (uploads.some(upload => upload.id && retiring.has(key(serverId, upload.id))))
    throw new Error('An attached file is being released. Your message is kept; wait for cleanup and review its attachments before retrying.');
}
