import {sha256} from '@noble/hashes/sha2.js';
export type AssistantInvocation={id:string;serverId:string;chatId:string;question:string;context:string;source:string;remainingMs:number};
export type AssistantRequest={serverId:string;chatId:string;clientId:string;body:string;digest:string};
export function invocationId(value:unknown):string|null{return typeof value==='string' && /^[a-f0-9]{32}$/.test(value) ? value : null;}
export function readInvocation(value:unknown,expected:string):AssistantInvocation{
  const data=value as AssistantInvocation;
  if(!data || data.id!==expected || !invocationId(data.id) || !Number.isFinite(data.remainingMs) || data.remainingMs<=0 || data.remainingMs>90000)
    throw new Error('This assistant invocation expired. Invoke Winglet again.');
  for(const [key,max]of [['serverId',160],['chatId',160],['question',4000],['context',6000],['source',160]] as const)
    if(typeof data[key]!=='string' || data[key].length>max)throw new Error('The assistant context could not be verified.');
  return {...data};
}
export function assistantPrompt(question:string,includeContext:boolean,invocation:AssistantInvocation):string{
  const text=question.trim();
  if(!text || text.length>4000)throw new Error('Enter a question of up to 4000 characters.');
  if(text.startsWith('/'))throw new Error('Use the full chat for commands.');
  return includeContext && invocation.context ?
    text+'\n\nUser-approved Android screen text:\n'+JSON.stringify({source:invocation.source,text:invocation.context},null,2) : text;
}
export class AssistantRequestBinding {
  private request:AssistantRequest|null=null;
  clear(){this.request=null;}
  freeze(serverId:string,chatId:string,question:string,includeContext:boolean,invocation:AssistantInvocation):AssistantRequest{
    if(this.request)return this.request;
    if(!serverId || !chatId)throw new Error('Choose a connected bot and conversation.');
    const body=assistantPrompt(question,includeContext,invocation);
    const digest=Array.from(sha256(new TextEncoder().encode(body)),v=>v.toString(16).padStart(2,'0')).join('');
    this.request=Object.freeze({serverId,chatId,clientId:'assistant-'+invocation.id,body,digest});
    return this.request;
  }
}

