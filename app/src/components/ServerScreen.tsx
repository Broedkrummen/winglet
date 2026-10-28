import { router } from 'expo-router';
import { type ComponentType } from 'react';
import { Text, View } from 'react-native';
import { useApp } from '../lib/store';
import { useTheme } from '../lib/themeContext';
import { ServerScreenContext } from '../lib/serverScreenContext';
import { Screen } from './Screen';
import { Button } from './ui';

/** Bot-scoped pages get fresh forms and requests when the selected bot changes. */
export function withSelectedServer(Component: ComponentType) {
  return function SelectedServerScreen() {
    const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
    const t = useTheme();
    if (!server) return <Screen title="Connect a bot">
      <View style={{ gap: 16, marginTop: 16 }}>
        <Text style={{ ...t.type.body, color: t.colors.textSecondary }}>No bot connected.</Text>
        <Button title="Pair a bot" onPress={() => router.push('/pair')} />
      </View>
    </Screen>;
    return <ServerScreenContext.Provider value={server.bot.title}>
      <Component key={`${server.id}:${server.profile ?? ''}`} />
    </ServerScreenContext.Provider>;
  };
}
