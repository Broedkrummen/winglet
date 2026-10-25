import { router } from 'expo-router';
import { NavigationToggle } from '../components/AppNavigation';
import { Bell, Bot, Info, Palette, Smartphone } from '../components/icons';
import { Screen } from '../components/Screen';
import { ListGroup, ListRow, SectionHeader, Segmented } from '../components/ui';
import { useApp } from '../lib/store';
import { usePrefs } from '../lib/prefs';
import { useTheme } from '../lib/themeContext';

export default function SettingsScreen() {
  const t = useTheme();
  const phoneTools = useApp(s => !!s.runtime[s.selection.serverId ?? '']?.info?.features.phone_tools);
  const mode = usePrefs((s) => s.prefs.sidebar);
  return <Screen title="Settings" right={<NavigationToggle />}>
    <SectionHeader title="Navigation" />
    <Segmented label="Sidebar" value={mode} onChange={(sidebar) => usePrefs.getState().update({ sidebar })} options={[
      { value: 'auto', label: 'Automatic' }, { value: 'drawer', label: 'Drawer' }, { value: 'pinned', label: 'Pinned' },
    ]} />
    <SectionHeader title="App" />
    <ListGroup>
      <ListRow title="Appearance" icon={<Palette size={19} color={t.colors.onAccentSoft} />} onPress={() => router.push('/appearance')} />
      <ListRow title="Notifications" icon={<Bell size={19} color={t.colors.onAccentSoft} />} onPress={() => router.push('/notifications')} />
      <ListRow title="Your bots" icon={<Smartphone size={19} color={t.colors.onAccentSoft} />} onPress={() => router.push('/bots')} />
      <ListRow title="About & storage" icon={<Info size={19} color={t.colors.onAccentSoft} />} onPress={() => router.push('/about')} />
    </ListGroup>
    <SectionHeader title="Agent" />
    <ListGroup><ListRow title="Agent settings" subtitle="Models, memory, activity, connections and security" icon={<Bot size={19} color={t.colors.onAccentSoft} />} onPress={() => router.navigate('/agent')} /></ListGroup>
    {phoneTools ? <ListGroup><ListRow title="Phone tools" subtitle="Choose what this Android phone can share" icon={<Smartphone size={19} color={t.colors.onAccentSoft} />} onPress={() => router.push('/phone-tools')} /></ListGroup> : null}
  </Screen>;
}
