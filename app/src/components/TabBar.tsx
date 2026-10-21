import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Legacy section callers now reserve only the system safe area; navigation lives in the sidebar. */
export function useTabBarSpace(): number {
  return Math.max(useSafeAreaInsets().bottom, 12);
}
