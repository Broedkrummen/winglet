import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { idempotencyKey } from '../../lib/control';

/** Bytes have already passed the private source's metadata, size and digest checks. */
export async function exportSyncBytes(name: string, data: Uint8Array) {
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([new Uint8Array(data)]));
    const link = document.createElement('a');
    link.href = url; link.download = name; link.rel = 'noopener';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return;
  }
  const directory = new Directory(Paths.cache, `sync-export-${idempotencyKey()}`);
  directory.create({ intermediates: true });
  try {
    const file = new File(directory, name);
    file.write(data);
    await Sharing.shareAsync(file.uri, { dialogTitle: name });
  } finally { directory.delete(); }
}
