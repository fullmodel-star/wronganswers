const CACHE='cuoti-v20';
const ASSETS=['./','./index.html','./manifest.webmanifest','./ridgeline-ui.css','./favicon.svg','./icon.svg','./icon-180.png','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>{
  // 不自動 skipWaiting：讓新版進入「等待」，由 App 詢問使用者後再接管
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
// App 按下「立即更新」時通知新版接管
self.addEventListener('message',e=>{
  if(e.data==='SKIP_WAITING'||(e.data&&e.data.type==='SKIP_WAITING'))self.skipWaiting();
});
self.addEventListener('fetch',e=>{
  const req=e.request, url=req.url;
  if(url.includes('generativelanguage.googleapis.com'))return; // Gemini 走網路不快取
  if(req.method!=='GET')return;
  // 導覽請求(HTML)採 network-first：優先拿最新，離線再退回快取，確保能收到新版
  if(req.mode==='navigate'||(req.headers.get('accept')||'').includes('text/html')){
    e.respondWith(
      fetch(req).then(resp=>{const cp=resp.clone();caches.open(CACHE).then(c=>c.put('./index.html',cp));return resp;})
        .catch(()=>caches.match(req).then(r=>r||caches.match('./index.html')))
    );
    return;
  }
  // 其他資源 cache-first
  e.respondWith(
    caches.match(req).then(r=>r||fetch(req).then(resp=>{
      if(resp.ok&&url.startsWith(self.location.origin)){const cp=resp.clone();caches.open(CACHE).then(c=>c.put(req,cp));}
      return resp;
    }).catch(()=>caches.match('./index.html')))
  );
});
