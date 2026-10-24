import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { fetch } from 'expo/fetch';
import { Platform } from 'react-native';
import { ApiError, botPath } from './api';
import type { Server } from './types';

/** Save the whole chat as a Markdown file: the share sheet on a phone, a download in the browser. */
export async function exportChat(server: Server, chatId: string, title: string): Promise<void> {
  const resp = await fetch(`${server.url}${botPath(server, `/api/chats/${encodeURIComponent(chatId)}/export`)}`, {
    headers: { Authorization: `Bearer ${server.token}` },
    redirect: 'error',
  }).catch(() => {
    throw new ApiError(`Couldn't reach ${server.bot.title}. Try again when you're back online.`, 0);
  });
  if (!resp.ok) throw new ApiError(`Export failed (${resp.status})`, resp.status);
  const text = await resp.text();
  const name = `${title.replace(/[^\w .-]+/g, '').trim().slice(0, 60) || 'chat'}.md`;
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return;
  }
  const dir = new Directory(Paths.cache, 'export');
  if (!dir.exists) dir.create({ intermediates: true });
  const file = new File(dir, name);
  if (file.exists) file.delete();
  file.create();
  file.write(text);
  await Sharing.shareAsync(file.uri, { mimeType: 'text/markdown', dialogTitle: name, UTI: 'net.daringfireball.markdown' });
}
