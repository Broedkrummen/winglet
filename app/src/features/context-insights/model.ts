export type ContextCategory={id:string;label:string;tokens:number|null};
export type ContextAmount={used:number|null;window:number|null;source:string;categories:ContextCategory[];estimated_total:number|null};
export type CompressionRequest={operation_id:string;revision:string};
// A rejection was not accepted; network, timeout and server failures may hide a receipt.
export const compressionRetryRequest=(pending:CompressionRequest|null,status?:number)=>status!==undefined&&status>=400&&status<500&&status!==408?null:pending;
export type ContextOperation={operation_id:string;status:'running'|'completed'|'unchanged'|'refused'|'unknown';outcome:string;before?:ContextAmount;after?:ContextAmount;revision?:string};
export type ContextView={chat_id:string;revision:string;model:string;provider:string;context:ContextAmount;busy:boolean;can_compress:boolean;sampled_at:number;
  compression_count:number|null;last_operation:ContextOperation|null;warning:string;
  usage:{input_tokens:number|null;output_tokens:number|null;cache_read_tokens:number|null;cache_write_tokens:number|null;reasoning_tokens:number|null;api_call_count:number|null;cost:{value:number|null;currency:string;source:string}};
  details:{skills:{name:string;index_tokens:number|null;file_tokens:number|null}[];toolsets:{name:string;tokens:number|null;tools:number|null}[]};
  rate_limits:{label:string;limit:number|null;remaining:number|null;captured_at:number|null;resets_at:number|null}[]};
export type AccountView={available:boolean;pending?:boolean;provider:string;kind?:string;fetched_at?:number;reason?:string;cached?:boolean;age_seconds?:number;
  windows:{label:string;used_percent:number|null;resets_at:number|null;detail?:string}[];details:string[]};
export const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export const tokenCount=(value:unknown)=>finite(value)?new Intl.NumberFormat(undefined,{maximumFractionDigits:0}).format(value):'Unknown';
export const contextPercent=(value:ContextAmount)=>finite(value.used)&&finite(value.window)&&value.window>0?Math.min(100,Math.max(0,value.used/value.window*100)):null;
export function composition(categories:ContextCategory[]){const total=categories.reduce((sum,c)=>sum+(finite(c.tokens)?c.tokens:0),0);return categories.filter(c=>finite(c.tokens)&&c.tokens>0).map(c=>({...c,share:total>0?c.tokens!/total:0}));}
/** Every category for display, unknown ones included; shares are of the known estimates when some are unknown. */
export function contextRows(categories:ContextCategory[]){const known=composition(categories);const partial=categories.some(c=>!finite(c.tokens));return categories.map(c=>{const k=known.find(x=>x.id===c.id);return {...c,share:k?k.share:finite(c.tokens)?0:null,partial};});}
export const sourceLabel=(source:string)=>source==='provider_usage'?'Provider measured':source==='provider_usage_plus_estimate'?'Provider usage + estimate':'Estimated';
export function costLabel(cost:ContextView['usage']['cost']){if(!finite(cost.value))return 'Unavailable';return `${cost.source==='measured'?'Measured':'Estimated'} ${cost.currency} ${cost.value.toFixed(4)}`;}
