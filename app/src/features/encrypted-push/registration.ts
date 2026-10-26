/** Pure orchestration; the native key store, pinned sealing and signed API are injected. */
export type EnrollmentCredentials={v:1;kid:string;key:string;revision:number;subscription:{endpoint:string;keys:{p256dh:string;auth:string}}};
export type RemotePushStatus={v:1;enrolled:boolean;encrypted_required:boolean;kid:string|null;relay?:string;acceptance?:{at:number;ok:boolean}|null;delivery:string};
type Ports={
  assertActive:()=>void;
  status:()=>Promise<RemotePushStatus>;
  credentials:()=>Promise<EnrollmentCredentials>;
  post:(data:EnrollmentCredentials & {previous_kid:string|null})=>Promise<RemotePushStatus>;
  activate:(kid:string,revision:number)=>Promise<void>;
};
export async function syncPushRegistration(port:Ports):Promise<RemotePushStatus>{
  port.assertActive();
  const before=await port.status();port.assertActive();
  if(before.v!==1 || (before.kid!==null && !/^[a-f0-9]{32}$/.test(before.kid)) || before.enrolled!==(before.kid!==null))
    throw new Error('Update the server and refresh encrypted notification status.');
  const data=await port.credentials();port.assertActive();
  if(data.v!==1 || !/^[a-f0-9]{32}$/.test(data.kid) || !Number.isInteger(data.revision) || data.revision<1)
    throw new Error('The notification registration could not be verified. Rotate its key and retry.');
  const result=await port.post({...data,previous_kid:before.kid});port.assertActive();
  if(!result.enrolled || result.v!==1 || result.kid!==data.kid)throw new Error('The server did not confirm this notification key. Retry repair.');
  await port.activate(data.kid,data.revision);port.assertActive();
  return result;
}
