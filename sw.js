/* RL_FRESH_START — 2026-10-19 全家族「離線要有，但不能擋更新」（母版：04_管理工具\PWA新鮮度\rl_fresh_sw.js，用 apply.py 重新套用，不要在這裡手改）
   問題：原本 fetch 對網頁本身也是 cache-first → 重整先畫舊畫面、發新版要開兩次才看得到。
   做法：這段排在 sw.js 最前面、最先註冊 fetch：網頁／程式／樣式／資料（.html .js .mjs .css .json 與導覽）一律先拿線上最新的，
   4 秒沒回應或離線才用快取；成功時存一份到 rl-fresh 快取，離線也有最新版可用。
   圖片、字型、地圖圖磚等其他檔案不攔，交給原本的 handler（照舊 cache-first）。
   攔下的請求呼叫 stopImmediatePropagation()，原本的 fetch handler 不會再處理同一個請求。 */
(function(){
  var FRESH = 'rl-fresh';
  var CODE = /\.(?:html?|m?js|css|json|webmanifest)$/i;
  function fromCache(req){
    return caches.match(req).then(function(r){
      if (r) return r;
      return caches.match(req, { ignoreSearch: true }).then(function(r2){
        if (r2 || req.mode !== 'navigate') return r2;
        return caches.match('./').then(function(r3){ return r3 || caches.match('./index.html') || caches.match('index.html'); });
      });
    });
  }
  function fresh(e, req){
    var net = fetch(req).then(function(res){
      if (res && res.ok && res.type === 'basic'){
        var copy = res.clone();
        e.waitUntil(caches.open(FRESH).then(function(c){ return c.put(req, copy); }).catch(function(){}));
      }
      return res;
    });
    var timer = new Promise(function(resolve){ setTimeout(function(){ resolve(null); }, 4000); });
    return Promise.race([net.catch(function(){ return null; }), timer]).then(function(res){
      if (res && (res.ok || res.status === 304 || res.type === 'opaqueredirect')) return res;
      return fromCache(req).then(function(c){
        if (c) return c;
        return net.catch(function(){ return Response.error(); });   /* 快取也沒有：再等網路（可能只是慢） */
      });
    });
  }
  self.addEventListener('fetch', function(e){
    var req = e.request;
    if (req.method !== 'GET') return;
    var url; try { url = new URL(req.url); } catch (x) { return; }
    if (url.origin !== self.location.origin) return;
    if (url.pathname.indexOf('/api/') === 0) return;          /* 有自己 API 的 App（Worker）交給原本邏輯 */
    var isDoc = req.mode === 'navigate' || url.pathname.slice(-1) === '/' || CODE.test(url.pathname);
    if (!isDoc) return;
    if (url.pathname.slice(-6) === '/sw.js' || url.pathname === '/sw.js') return;
    e.stopImmediatePropagation();
    e.respondWith(fresh(e, req));
  });
})();
/* RL_FRESH_END */
const CACHE='cuoti-v44';
const ASSETS=['./','./index.html','./manifest.webmanifest','./ridgeline-ui.css','./rl-mark-denali-navy.png','./rl-mark-denali-white.png','./favicon.svg','./icon.svg','./icon-180.png','./icon-192.png','./icon-512.png','./icon-maskable-512.png',
  // 2026-10-19 版面美化「修練手帳」：粉圓子集字型＋Fluent 3D 圖
  './vendor/round-ui/wb-round.woff2','./vendor/fluent-3d/book.png','./vendor/fluent-3d/pencil.png','./vendor/fluent-3d/fire.png','./vendor/fluent-3d/grad.png','./vendor/fluent-3d/chart.png','./vendor/fluent-3d/gear.png','./vendor/fluent-3d/stopwatch.png','./vendor/fluent-3d/camera.png','./vendor/fluent-3d/search.png'];
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
