/* Pure receive policy shared by the service worker and deterministic tests. */
(function(root){
  const ID=/^[a-f0-9]{32}$/;
  function safeTarget(value,origin){
    if(typeof value!=='string' || value.length>1024 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\'))return '/';
    try{const target=new URL(value,origin);return target.origin===origin && !target.pathname.startsWith('/api/')?target.pathname+target.search+target.hash:'/';}catch{return '/';}
  }
  function accept(note,state,now){
    const seen=Object.fromEntries(Object.entries(state.seen||{}).filter(([,expires])=>Number.isSafeInteger(expires)&&expires>now));
    const next={required:!!state.required,scope:state.scope||null,seen};
    if(!note || typeof note!=='object' || Array.isArray(note))return {state:next,note:null};
    for(const [field,max] of [['title',180],['body',1200],['url',1024],['tag',160],['server_id',160]])
      if(typeof note[field]!=='string' || note[field].length>max)return {state:next,note:null};
    if(note.guard_v===1){
      if(!next.scope || note.server_id!==next.scope.server || note.device_id!==next.scope.device || !ID.test(note.id) ||
        !Number.isSafeInteger(note.issued) || !Number.isSafeInteger(note.expires) || note.issued<0 || note.issued>now+60 ||
        note.expires<=now || note.expires<note.issued || note.expires-note.issued>86400 || now-note.issued>86400 ||
        seen[note.id]!==undefined || Object.keys(seen).length>=2048)return {state:next,note:null};
      next.required=true;seen[note.id]=note.expires;
    }else if(next.required || note.guard_v!==undefined){return {state:next,note:null};}
    // Actions only open the current authenticated UI, including old cached notifications.
    const clean={title:note.title,body:note.body,url:note.url,tag:note.tag,kind:note.kind,server_id:note.server_id};
    return {state:next,note:clean};
  }
  root.WingletPushGuard={accept,safeTarget};
})(globalThis);
