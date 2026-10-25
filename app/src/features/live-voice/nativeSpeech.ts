export type DeviceSpeechCapabilities={listen:boolean;speak:boolean;language:string;voice:string;engine:string;listenReason:string;speakReason:string};
export type NativeSpeechEvent={id:string;kind:string;text?:string;level?:number};
export interface NativeSpeechPort {
  capabilities(language:string):Promise<DeviceSpeechCapabilities>;
  startRecognition(id:string,language:string):Promise<void>;
  finishRecognition(id:string):Promise<void>;
  cancelRecognition(id:string):Promise<void>;
  speak(id:string,text:string,language:string):Promise<void>;
  cancelSpeech(id:string):Promise<void>;
  addListener(channel:'recognition'|'synthesis',listener:(event:NativeSpeechEvent)=>void):{remove():void};
}
let next=0;
const requestId=(kind:string)=>'native-'+kind+'-'+Date.now()+'-'+(++next);
const cancelled=()=>new Error('Cancelled');
export function nativeSpeech(port:NativeSpeechPort,permission:(signal:AbortSignal)=>Promise<boolean>,language=()=> '') {
  return {
    probe:()=>port.capabilities(language()),
    dictate(signal:AbortSignal,partial:(text:string)=>void,setFinish:(finish:()=>void)=>void,onStarted:()=>void,onLevel:(level:number)=>void=()=>undefined):Promise<string>{
      return new Promise((resolve,reject)=>{
        const id=requestId('listen');let done=false;let started=false;
        let grace:ReturnType<typeof setTimeout>|undefined;
        let subscription:{remove():void}|undefined;
        const settle=(error?:Error,text='')=>{
          if(done)return;done=true;clearTimeout(limit);if(grace)clearTimeout(grace);
          signal.removeEventListener('abort',abort);subscription?.remove();onLevel(0);
          void port.cancelRecognition(id).catch(()=>undefined);
          error?reject(error):resolve(text.slice(0,8000));
        };
        const abort=()=>settle(cancelled());
        const finish=()=>{
          if(done)return;
          if(!started){settle();return;}
          void port.finishRecognition(id).catch(()=>settle(new Error('Device recognition could not finish. Try again.')));
          if(!grace)grace=setTimeout(()=>settle(new Error('Device recognition timed out. Choose Server or retry.')),8000);
        };
        const limit=setTimeout(finish,60000);
        try { subscription=port.addListener('recognition',(event)=>{
          if(done||event.id!==id)return;
          if(event.kind==='ready')onStarted();
          else if(event.kind==='partial')partial((event.text??'').slice(0,8000));
          else if(event.kind==='level'&&Number.isFinite(event.level))onLevel(Math.max(0,Math.min(1,event.level!)));
          else if(event.kind==='final')settle(undefined,event.text??'');
          else if(event.kind==='error')settle(new Error(event.text||'On-device recognition failed. Choose Server.'));
        }); } catch { settle(new Error('Device speech module unavailable. Choose Server.')); return; }
        setFinish(finish);signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted){abort();return;}
        void (async()=>{
          if(!await permission(signal))throw new Error('Microphone permission denied. Allow microphone access in Settings.');
          if(done||signal.aborted)return;
          started=true;await port.startRecognition(id,language());
          if(done)void port.cancelRecognition(id).catch(()=>undefined);
        })().catch(error=>settle(error instanceof Error?error:new Error('On-device recognition could not start.')));
      });
    },
    say(text:string,signal:AbortSignal):Promise<void>{
      return new Promise((resolve,reject)=>{
        const id=requestId('speak');let done=false;let subscription:{remove():void}|undefined;
        const settle=(error?:Error)=>{
          if(done)return;done=true;clearTimeout(limit);signal.removeEventListener('abort',abort);subscription?.remove();
          void port.cancelSpeech(id).catch(()=>undefined);
          error?reject(error):resolve();
        };
        const abort=()=>settle(cancelled());
        const limit=setTimeout(()=>settle(new Error('Device speech timed out. Choose Server or retry.')),90000);
        try { subscription=port.addListener('synthesis',(event)=>{
          if(done||event.id!==id)return;
          if(event.kind==='done')settle();
          else if(event.kind==='error')settle(new Error(event.text||'Device speech failed. Choose Server.'));
        }); } catch { settle(new Error('Device speech module unavailable. Choose Server.')); return; }
        signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted){abort();return;}
        void port.speak(id,text,language()).then(()=>{if(done)void port.cancelSpeech(id).catch(()=>undefined);})
          .catch(error=>settle(error instanceof Error?error:new Error('Device speech could not start.')));
      });
    },
  };
}
