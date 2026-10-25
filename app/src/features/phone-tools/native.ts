import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import type { Tool } from './policy';
type Native = { permission: (tool: Tool) => Promise<{ granted: boolean; canAskAgain: boolean }>;
  requestPermission: (tool: Tool) => Promise<{ granted: boolean; canAskAgain: boolean }>;
  openSettings: () => Promise<void>; execute: (id: string, tool: Tool, args: object, expires: number) => Promise<unknown>; cancel: (id: string) => void };
export const nativePhone = Platform.OS === 'android' ? requireOptionalNativeModule<Native>('WingletPhoneTools') : null;
export const phoneSupported = Platform.OS === 'android' && !!nativePhone;
