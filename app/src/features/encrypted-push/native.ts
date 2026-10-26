import {Platform} from 'react-native';
import {requireOptionalNativeModule} from 'expo-modules-core';
export type LocalPushStatus={registered:boolean;active:boolean;kid?:string;keyLost?:boolean;needsSync?:boolean;previews?:boolean;error?:string;received?:number;decrypted?:number;displayed?:number;suppressed?:number};
export type PushCredentials={v:1;kid:string;key:string;revision:number;subscription:{endpoint:string;keys:{p256dh:string;auth:string}}};
export type PushCapabilities={supported:boolean;notificationsAllowed:boolean;distributors:{id:string;name:string}[]};
export type PushNative={
  security:(locked:boolean,privatePreviews:boolean,foreground:boolean,online:string[],pairs:{server:string;device:string}[])=>void;
  capabilities:()=>Promise<PushCapabilities>;requestPermission:()=>Promise<{granted:boolean}>;
  status:(server:string,device:string)=>Promise<LocalPushStatus>;
  prepare:(server:string,device:string,distributor:string,vapid:string,rotate:boolean)=>Promise<LocalPushStatus>;
  credentials:(server:string,device:string)=>Promise<PushCredentials>;
  activate:(server:string,device:string,kid:string,revision:number)=>Promise<void>;
  previews:(server:string,device:string,enabled:boolean)=>Promise<void>;
  remove:(server:string,device:string)=>Promise<void>;
  retain:()=>Promise<void>;
};
export const pushNative=Platform.OS==='android' && Number(Platform.Version)>=26?requireOptionalNativeModule<PushNative>('WingletPush'):null;
