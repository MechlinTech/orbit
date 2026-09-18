// Never cache candidate data, authenticated pages, API responses, or auth redirects.
const CACHE='orbit-offline-v2';
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.add('/offline.html')));self.skipWaiting();});
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{if(event.request.mode==='navigate' && new URL(event.request.url).pathname==='/')event.respondWith(fetch(event.request).catch(()=>caches.match('/offline.html')));});
