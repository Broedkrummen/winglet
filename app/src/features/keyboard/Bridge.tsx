import { usePathname } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useAppNavigation } from '../../components/AppNavigation';
import { useLock } from '../../lib/appLock';
import { shortcutCommand } from './commands';
import { runCommand } from './actions';
import { keyboardTarget } from './webContext';

/** Mounted once inside the navigation shell; embedded desktops retain all their input. */
export function KeyboardBridge() {
  const navigation = useAppNavigation();
  const pathname = usePathname();
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const key = (event: KeyboardEvent) => {
      const command = shortcutCommand(event, {
        locked: useLock.getState().locked,
        ...keyboardTarget(event, pathname),
      });
      if (!command) return;
      event.preventDefault();
      void runCommand(command, navigation);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [navigation, pathname]);
  return null;
}
