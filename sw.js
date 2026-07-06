const CACHE='cuoti-v2';
const ASSETS=['./','./index.html','./manifest.webmanifest','./icon.svg'];
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  const url=e.request.url;
  // Gemini API 一律走網路，不快取
  if(url.includes('generativelanguage.googleapis.com')){return}
  e.respondWith(
    caches.match(e.request).then(r=>r||fetch(e.request).then(resp=>{
      if(e.request.method==='GET'&&resp.ok&&url.startsWith(self.location.origin)){
        const cp=resp.clone();caches.open(CACHE).then(c=>c.put(e.request,cp));
      }
      return resp;
    }).catch(()=>caches.match('./index.html')))
  );
});
