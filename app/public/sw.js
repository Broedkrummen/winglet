importScripts('/push-guard.js');
/* Winglet service worker: keeps the app shell for offline use, shows push notifications, handles taps. */
const SHELL = 'winglet-shell-v1';
const HASHED = /^\/(_expo\/static|assets)\//;

/** Cache the page and every bundle it references, dropping bundles from older builds. */
async function cacheShell(response) {
  const cache = await caches.open(SHELL);
  const html = await response.clone().text();
  await cache.put('/', response.clone());
  const refs = new Set([...html.matchAll(/(?:src|href)="(\/(?:_expo\/static|icons)\/[^"]+)"/g)].map((m) => m[1]));
  await Promise.all([...refs].map((ref) => cache.match(ref).then((hit) => hit || cache.add(ref).catch(() => undefined))));
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/_expo/static/') && !refs.has(path)) await cache.delete(request);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(fetch('/', { cache: 'no-store' }).then((r) => (r.ok ? cacheShell(r) : undefined)).catch(() => undefined)
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // The API is never cached: it's live data, and responses can be private to this device.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    // Network first so updates arrive at once; the cached shell opens the app when the server is down.
    event.respondWith(fetch(request).then((response) => {
      if (response.ok && (response.headers.get('content-type') || '').includes('text/html')) {
        event.waitUntil(cacheShell(response.clone()).catch(() => undefined));
      }
      return response;
    }).catch(() => caches.match('/').then((hit) => hit || Response.error())));
    return;
  }
  const keep = (response) => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(SHELL).then((cache) => cache.put(request, copy)));
    }
    return response;
  };
  if (HASHED.test(url.pathname)) {
    // Bundles and fonts are content-hashed, so a cached copy is always the right one.
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then(keep)));
  } else if (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(fetch(request).then(keep).catch(() => caches.match(request).then((hit) => hit || Response.error())));
  }
});

// Atomic read/update keeps replay records durable across worker termination.
function pushState(update){
  return new Promise((resolve,reject)=>{
    const opening=indexedDB.open('winglet-push-v1',1);
    opening.onupgradeneeded=()=>opening.result.createObjectStore('state');
    opening.onerror=()=>reject(new Error('push storage unavailable'));
    opening.onsuccess=()=>{
      const db=opening.result,tx=db.transaction('state','readwrite'),store=tx.objectStore('state');
      let result;
      const request=store.get('guard');
      request.onsuccess=()=>{
        try{result=update(request.result||{required:false,scope:null,seen:{}});store.put(result.state,'guard');}
        catch{tx.abort();}
      };
      tx.oncomplete=()=>{db.close();resolve(result);};
      tx.onerror=tx.onabort=()=>{db.close();reject(new Error('push storage unavailable'));};
    };
  });
}
self.addEventListener('message',event=>{
  const message=event.data;
  if(!['winglet.push.configure','winglet.push.retain'].includes(message?.type))return;
  try{if(!event.source?.url || new URL(event.source.url).origin!==self.location.origin)return;}catch{return;}
  const scope=message.scope;
  if(scope!==null && (!scope || typeof scope.server!=='string' || typeof scope.device!=='string' ||
    !scope.server || !scope.device || scope.server.length>160 || scope.device.length>160))return;
  event.waitUntil(pushState(state=>{
    const same=scope && state.scope && scope.server===state.scope.server && scope.device===state.scope.device;
    if(message.type==='winglet.push.retain')return {state:same?state:{required:scope===null||state.required,scope:null,seen:{}}};
    return {state:{required:true,scope,seen:same?state.seen:{}}};
  }).then(()=>event.ports[0]?.postMessage({ok:true})).catch(()=>event.ports[0]?.postMessage({ok:false})));
});
self.addEventListener('push',event=>{
  let note;
  try{const text=event.data?.text();if(!text || text.length>4000)return;note=JSON.parse(text);}catch{return;}
  event.waitUntil(pushState(state=>WingletPushGuard.accept(note,state,Math.floor(Date.now()/1000))).then(result=>{
    const safe=result.note;if(!safe)return;
    return self.registration.showNotification(safe.title||'Winglet',{
      body:safe.body,tag:safe.tag,renotify:!!safe.tag,icon:'/icons/icon-192.png',badge:'/icons/badge-96.png',
      data:safe,requireInteraction:safe.kind==='approval'||safe.kind==='question',
    });
  }).catch(()=>undefined));
});

self.addEventListener('notificationclick', event => {
  const note=event.notification.data||{};
  event.notification.close();
  const target=WingletPushGuard.safeTarget(note.url||'/',self.location.origin);
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients=>{
    for(const client of clients){
      if('focus' in client){client.navigate(target).catch(()=>undefined);return client.focus();}
    }
    return self.clients.openWindow(target);
  }));
});
