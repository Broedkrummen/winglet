import {Platform} from 'react-native';
import {requireOptionalNativeModule} from 'expo-modules-core';
export type WatchPending={association:string;name:string;code:string;expires:number};
export type WatchLink={association:string;name:string;serverId:string;grantId:string;expires:number;background:boolean};
export type WearNative={
  security:(locked:boolean,foreground:boolean,pairs:string[])=>void;
  capabilities:()=>Promise<{supported:boolean}>;
  status:()=>Promise<{pending:WatchPending[];links:WatchLink[]}>;
  finish:(association:string,config:Record<string,unknown>)=>Promise<void>;
  remove:(association:string)=>Promise<void>;cancel:(association:string)=>Promise<void>;
  retain:()=>Promise<void>;reset:()=>Promise<void>;
};
export const wearNative=Platform.OS==='android'?requireOptionalNativeModule<WearNative>('WingletWear'):null;
