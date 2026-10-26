import {requireOptionalNativeModule} from 'expo-modules-core';
import {Platform} from 'react-native';
import type {AssistantInvocation} from './model';
export type AssistantNative={
  security:(locked:boolean,lockEnabled:boolean,foreground:boolean,server:string,chat:string,title:string)=>void;
  discard:(id:string)=>void;discardAll:()=>void;
  capabilities:()=>Promise<{supported:boolean;held:boolean}>;
  requestRole:()=>Promise<void>;peek:(id:string)=>Promise<AssistantInvocation>;
  bind:(id:string,server:string,chat:string,request:string,digest:string)=>Promise<void>;
  protect:(id:string)=>Promise<void>;unprotect:(id:string)=>void;
};
export const assistantNative=Platform.OS==='android'?requireOptionalNativeModule<AssistantNative>('WingletAssistant'):null;

