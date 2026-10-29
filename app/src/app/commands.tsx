import { router } from 'expo-router';
import { useState } from 'react';
import { Platform } from 'react-native';
import { useAppNavigation } from '../components/AppNavigation';
import { Screen } from '../components/Screen';
import { Footnote, ListGroup, ListRow, SearchField } from '../components/ui';
import { useBotSheet } from '../components/BotSwitcher';
import { useLock } from '../lib/appLock';
import { useApp } from '../lib/store';
import { findCommands, shortcutLabel } from '../features/keyboard/commands';
import { runCommand } from '../features/keyboard/actions';

export default function CommandsScreen() {
  const [query, setQuery] = useState('');
  const navigation = useAppNavigation();
  const servers = useApp(state => state.servers);
  const selection = useApp(state => state.selection);
  const server = servers.find(item => item.id === selection.serverId) ?? servers[0];
  const picker = useBotSheet(server, () => router.navigate('/'));
  const mac = Platform.OS === 'web' && /Mac|iPhone|iPad/.test(navigator.platform);
  const matches = findCommands(query).filter(command => command.id !== 'commands');
  return <Screen title="Commands and shortcuts">
    <SearchField value={query} onChangeText={setQuery} placeholder="Find a command" autoFocus={Platform.OS === 'web'} />
    <Footnote>Open this list with {mac ? '⌘' : 'Ctrl'} + K outside text fields. Shortcuts pause while typing, composing, using a dialog or controlling a desktop.</Footnote>
    <ListGroup>{matches.map(command => <ListRow key={command.id} title={command.label} value={shortcutLabel(command, mac)}
      disabled={!server && (command.id === 'new-chat' || command.id === 'bots')}
      onPress={() => { if (!useLock.getState().locked) { if (command.id === 'bots') picker.open(); else void runCommand(command.id, navigation); } }} />)}</ListGroup>
    {!matches.length ? <Footnote>No commands match. Try “chat”, “bot” or “settings”.</Footnote> : null}
    {picker.sheet}
  </Screen>;
}
