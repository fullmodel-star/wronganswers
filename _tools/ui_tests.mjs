/**
 * 701 錯題管理器 · 瀏覽器層功能走查（安全網）
 *
 *   node _tools/ui_tests.mjs                      → 對專案根目錄跑
 *   node _tools/ui_tests.mjs --dir=<其他資料夾>     → 對別的副本跑（反向測試／部署包）
 *
 * 2026-10-03 建立。這支存的是使用者自己的錯題與照片（IndexedDB＋Blob），資料遺失是最嚴重的 bug，
 * 所以優先釘住：新增（含照片）→ 重新整理還在、編輯不丟照片、刪除要確認、連對 3 次畢業／答錯歸零、
 * 匯出→清空→匯入往返後逐欄一致（含照片位元組）。改 App 後下面每一項都必須照樣通過。
 *
 * 寫法（沿用 605／609 的坑）：
 * - 不用 --virtual-time-budget；一律真實時間輪詢（until）。
 * - 自己起 http server、送 Cache-Control: no-store；直接試綁埠，不先探測（Windows SO_REUSEADDR）。
 * - 每次執行用全新的 Chrome profile（mkdtemp）→ IndexedDB／localStorage／SW 都從零開始，
 *   上一次執行的資料不會影響這一次；同一次執行內的狀態是刻意一路累積的（重新整理後資料還在＝要測的東西）。
 * - init script：每次 open 先 remove 上一支再 add，整段包 IIFE；攔 alert／confirm／prompt／print、
 *   攔下載（<a download>.click() → 把 blob 內容讀回來給測試比對，不真的下載）。
 * - 資料是否真的寫進去，一律直接讀 IndexedDB（window.__idbAll），不信 App 的記憶體陣列 DATA。
 * - 每條斷言都印出樣本數或實際值，避免「空集合讓測試假通過」。
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dirArg = process.argv.find((a) => a.startsWith('--dir='));
const ROOT = path.resolve(HERE, '..', dirArg ? dirArg.slice(6) : '.');
const PHOTO = path.join(HERE, 'fixtures', 'photo.png');   // 320×240 PNG
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css',
  '.txt': 'text/plain', '.woff2': 'font/woff2' };

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 400) : '')); }
}

/* ── 靜態伺服器：直接試綁，失敗換下一個 ── */
const served404 = [];
async function startServer() {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const rel = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname);
    const p = path.join(ROOT, rel);
    if (!p.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    try {
      const b = await readFile(p);
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(b);
    } catch { served404.push(u.pathname); res.writeHead(404); res.end(); }
  });
  for (let port = 8810; port < 8860; port++) {
    const okBind = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (okBind) return { server, port };
  }
  throw new Error('找不到可用的埠');
}

/* ── 頁面端注入：在 App 任何程式碼之前執行 ── */
const INIT = `(() => {
  window.__alerts = []; window.__confirms = []; window.__confirmAnswer = true; window.__prints = 0; window.__downloads = [];
  window.alert = (m) => { window.__alerts.push(String(m)); };
  window.confirm = (m) => { window.__confirms.push(String(m)); return window.__confirmAnswer; };
  window.prompt = () => null;
  window.print = () => { window.__prints++; };
  // 匯出用 <a download>.click()：改成把 blob 內容讀回來，不真的下載
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) {
      const rec = { name: this.download, pending: true };
      window.__downloads.push(rec);
      fetch(this.href).then((r) => r.text()).then((t) => { rec.text = t; rec.pending = false; })
        .catch((e) => { rec.err = String(e); rec.pending = false; });
      return;
    }
    return origClick.call(this);
  };
  const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  window.__today = today0;
  // 直接讀 IndexedDB（不信 App 的記憶體陣列）。資料庫還不存在時回 null，避免 open() 建出沒有 store 的空庫害到 App
  window.__idbAll = async () => {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [{ name: 'cuotiDB' }];
    if (!dbs.some((d) => d.name === 'cuotiDB')) return null;
    return new Promise((res, rej) => {
      const r = indexedDB.open('cuotiDB');
      r.onerror = () => rej(r.error);
      r.onsuccess = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('questions')) { d.close(); res(null); return; }
        const q = d.transaction('questions', 'readonly').objectStore('questions').getAll();
        q.onsuccess = () => { d.close(); res(q.result.map((o) => Object.assign({}, o, {
          image: o.image instanceof Blob ? { blob: true, type: o.image.type, size: o.image.size } : (o.image ? 'str:' + String(o.image).slice(0, 25) : null) }))); };
        q.onerror = () => { d.close(); rej(q.error); };
      };
    });
  };
  // 讀某題照片的實際位元組（轉 dataURL）供往返比對
  // ⚠ id 不合法（例如題目根本沒寫進去→undefined）時 get() 會同步丟例外，沒接住的話 Promise 永遠不 resolve、整支測試卡死
  window.__idbImage = (id) => new Promise((res) => {
    if (typeof id !== 'string') { res(null); return; }
    const r = indexedDB.open('cuotiDB');
    r.onsuccess = () => {
      const d = r.result;
      let q;
      try { q = d.transaction('questions', 'readonly').objectStore('questions').get(id); } catch (e) { d.close(); res(null); return; }
      q.onerror = () => { d.close(); res(null); };
      q.onsuccess = () => {
        d.close();
        const im = q.result && q.result.image;
        if (!(im instanceof Blob)) { res(null); return; }
        const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(im);
      };
    };
    r.onerror = () => res(null);
  });
})();`;

/* ── 最小 CDP 用戶端 ── */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); this.errors = []; this.consoleErrors = [];
    this.requests = []; this.badResponses = []; this.initScript = null; this.navs = 0; }
  static async connect(debugPort) {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch { /* Chrome 還沒起來 */ }
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('接不上 Chrome 的 CDP');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.waiters.has(m.id)) { c.waiters.get(m.id)(m); c.waiters.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') {
        c.errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'unknown');
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        c.consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
      }
      if (m.method === 'Network.requestWillBeSent') c.requests.push(m.params.request.url);
      if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) c.badResponses.push(m.params.response.status + ' ' + m.params.response.url);
      // 主框架每完成一次導覽（含 location.reload）就 +1；用來抓「頁面自己重整」
      if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId && /^http/.test(m.params.frame.url)) c.navs++;
    };
    await c.send('Runtime.enable');
    await c.send('Page.enable');
    await c.send('Network.enable');
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => { this.waiters.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr, ms = 20000) {
    // 頁面端 Promise 若永遠不 resolve（App 壞掉時常見），不能讓整支測試卡死：逾時就丟例外
    let to;
    const r = await Promise.race([
      this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
      new Promise((_, rej) => { to = setTimeout(() => rej(new Error('eval 逾時 ' + ms + 'ms：' + expr.slice(0, 80))), ms); }),
    ]).finally(() => clearTimeout(to));
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  }
  async until(expr, ms = 8000, step = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await this.eval(expr, 5000)) return true; } catch { /* 還沒 ready／逾時 */ }
      await sleep(step);
    }
    return false;
  }
  async width(w, h = 844) {
    await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    await sleep(200);
  }
  /** 開頁面（＝重新整理）：不清任何儲存，資料要能活過這一步 */
  async open(url) {
    // ⚠ addScriptToEvaluateOnNewDocument 會累積：每次 open 先移除上一支，再整段包成 IIFE。
    if (this.initScript) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.initScript });
    const r = await this.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
    this.initScript = r.result && r.result.identifier;
    await this.send('Page.navigate', { url });
    // App init() 跑完才會在 #listArea 放東西（空狀態卡或題目卡）
    return this.until(`document.readyState==='complete' && document.getElementById('listArea') && document.getElementById('listArea').children.length > 0 && typeof window.__idbAll === 'function'`, 15000);
  }
  /** 對 <input type=file> 塞檔案（會觸發 change，等同使用者選檔） */
  async setFile(selector, file) {
    const doc = await this.send('DOM.getDocument', { depth: 1 });
    const q = await this.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector });
    if (!q.result || !q.result.nodeId) throw new Error('找不到 ' + selector);
    await this.send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [file] });
  }
}

const { server, port } = await startServer();
const BASE = `http://127.0.0.1:${port}/`;
const profile = await mkdtemp(path.join(tmpdir(), 'cuoti-ui-'));
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
let c;
async function cleanup() {
  // 等 Chrome 真的結束再刪 profile（只睡 300ms 時 Windows 檔案鎖還在，暫存 profile 會一路殘留）
  const exited = new Promise((res) => { if (chrome.exitCode !== null) res(); else chrome.once('exit', res); });
  try { chrome.kill(); } catch {}
  server.close();
  await Promise.race([exited, sleep(5000)]);
  try { await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {}
}

try {
  c = await CDP.connect(DEBUG_PORT);
  await c.width(390);
  const J = JSON.stringify;
  const idb = () => c.eval(`window.__idbAll()`);
  const rec = async (needle) => ((await idb()) || []).find((q) => (q.question || '').includes(needle));
  const cards = () => c.eval(`[...document.querySelectorAll('#listArea .qcard')].map(e=>e.textContent.replace(/\\s+/g,' ').trim())`);
  const DAY = 86400000;
  const today = () => c.eval(`window.__today()`);
  // 依按鈕文字點擊（scope 內第一個符合的）
  const clickBtn = (scope, text, exclude) => c.eval(`(()=>{const b=[...document.querySelectorAll(${J(scope + ' button')})].find(b=>b.textContent.includes(${J(text)})${exclude ? `&&!b.textContent.includes(${J(exclude)})` : ''}); if(!b) return false; b.click(); return true})()`);
  const clickCard = (needle) => c.eval(`(()=>{const e=[...document.querySelectorAll('#listArea .qcard')].find(e=>e.textContent.includes(${J(needle)})); if(!e) return false; e.click(); return true})()`);
  const toastHas = (t) => c.until(`(document.getElementById('toast').textContent||'').includes(${J(t)})`, 4000);
  const fill = (vals) => c.eval(`(()=>{const v=${J(vals)}; for(const k in v){document.getElementById(k).value=v[k]} return 1})()`);
  const pickSubject = (s) => c.eval(`(()=>{const ch=[...document.querySelectorAll('#fSubject .chip')].find(e=>e.textContent===${J(s)}); if(!ch) return false; if(!ch.classList.contains('on')) ch.click(); return ch.classList.contains('on')})()`);
  const goTab = (p) => c.eval(`(()=>{document.querySelector('nav.tabs button[data-p="${p}"]').click(); return 1})()`);

  /* ───────── 1 首訪 ───────── */
  console.log('\n[1 首訪（全新 profile、IndexedDB 為空）]');
  c.navs = 0;
  ok('1.1 頁面載入完成（init 跑完、#listArea 有內容）', await c.open(BASE));
  ok('1.2 沒有任何資料時顯示「開始建立你的錯題本」空狀態，篩選卡隱藏',
    await c.eval(`document.getElementById('listArea').textContent.includes('開始建立你的錯題本') && getComputedStyle(document.getElementById('filterCard')).display==='none'`));
  const db0 = await idb();
  ok('1.3 App 已建立 IndexedDB cuotiDB/questions 且是空的（實際 ' + (db0 ? db0.length : 'null') + ' 筆）', Array.isArray(db0) && db0.length === 0, db0);
  // 第一次造訪：sw.js activate 時 clients.claim() 會觸發 controllerchange；舊版直接 reload＝新使用者打開 1～2 秒後頁面自己重整。
  // 數主框架導覽次數：打開一次＝1，多出來的就是自己重整（605 的反向測試證明「頁面記號」法抓不到）。
  const controlled = await c.until(`!!(navigator.serviceWorker && navigator.serviceWorker.controller)`, 10000);
  await sleep(2500);
  ok('1.4 🔴 第一次造訪 Service Worker 接管後，頁面不會自己重整（導覽次數＝1，實測 ' + c.navs + '）',
    controlled && c.navs === 1, { controlled, navs: c.navs });

  /* ───────── 2 新增一題（含照片） ───────── */
  console.log('\n[2 新增一題（含照片）]');
  await c.eval(`document.getElementById('fab').click()`);
  ok('2.1 按 ＋ 開啟新增視窗（標題「新增錯題」）', await c.until(`document.getElementById('addModal').classList.contains('on') && document.getElementById('addTitle').textContent==='新增錯題'`, 3000));
  await c.setFile('#galIn', PHOTO);
  // PNG 會在背景被壓成 JPEG 再取代預覽；等到預覽變成 JPEG 才算處理完
  const prevJpeg = await c.until(`document.getElementById('photoPreview').style.display==='block' && document.getElementById('prevImg').src.startsWith('data:image/jpeg') && document.getElementById('prevImg').naturalWidth>0`, 8000);
  ok('2.2 選圖後顯示預覽，且已壓成 JPEG（預覽寬 ' + await c.eval(`document.getElementById('prevImg').naturalWidth`) + 'px）', prevJpeg);
  ok('2.3 沒有金鑰時不會自動送辨識（沒有連到 Google）', !c.requests.some((u) => u.includes('generativelanguage')), c.requests.filter((u) => /^https?:/.test(u) && !u.includes('127.0.0.1')));
  await pickSubject('數學');
  await fill({ fChapter: '對數' });
  await clickBtn('#addModal', '加入');
  await fill({ fQuestion: 'Q1 走查題：log_2 8 = ?', fMyAns: '4', fAns: '3', fExplain: '因為【2^3=8】', fSource: '走查卷A' });
  await clickBtn('#addModal .save-bar', '儲存', '續加');
  ok('2.4 按儲存後視窗關閉並提示「已加入錯題本」', await c.until(`!document.getElementById('addModal').classList.contains('on')`, 4000) && await toastHas('已加入錯題本'));
  const r1 = await rec('Q1 走查題');
  ok('2.5 IndexedDB 真的寫入這一題，欄位正確（科目/主題/答案/來源）',
    !!r1 && r1.subject === '數學' && r1.chapter === '對數' && J(r1.topics) === J(['對數']) && r1.ans === '3' && r1.myAns === '4' && r1.source === '走查卷A',
    r1 && { subject: r1.subject, chapter: r1.chapter, topics: r1.topics, ans: r1.ans, myAns: r1.myAns, source: r1.source });
  ok('2.6 照片以 JPEG Blob 存進 IndexedDB（' + (r1 && r1.image ? r1.image.type + ' ' + r1.image.size + ' bytes' : '無') + '）',
    !!r1 && r1.image && r1.image.blob === true && r1.image.type === 'image/jpeg' && r1.image.size > 1000, r1 && r1.image);
  ok('2.7 新題初始複習狀態：連對 0、未精熟、今天到期', !!r1 && r1.streak === 0 && r1.mastered === false && r1.nextReview === await today(), r1 && { streak: r1.streak, mastered: r1.mastered, nextReview: r1.nextReview });
  const c1 = await cards();
  ok('2.8 列表出現 1 張卡片且內容是剛加的題目（實際 ' + c1.length + ' 張）', c1.length === 1 && c1[0].includes('Q1 走查題'), c1);
  ok('2.9 卡片縮圖顯示得出來（寬 320）', await c.until(`(()=>{const i=document.querySelector('#listArea .qcard img.thumb'); return !!i && i.complete && i.naturalWidth===320})()`, 4000));
  const photoQ1 = await c.eval(`window.__idbImage(${J(r1 && r1.id)})`);

  /* ───────── 3 存並續加、未存內容防誤關 ───────── */
  console.log('\n[3 存並續加、未存內容不被誤關]');
  await c.eval(`document.getElementById('fab').click()`);
  await c.until(`document.getElementById('addModal').classList.contains('on')`, 3000);
  await pickSubject('英文');
  await fill({ fChapter: '時態', fQuestion: 'Q2 走查題：He ___ (go) to school yesterday.', fMyAns: 'goes', fAns: 'went', fSource: '走查卷B' });
  await clickBtn('#addModal .save-bar', '存並續加');
  await toastHas('繼續加下一題');
  ok('3.1 「存並續加」：存檔後視窗不關、題目欄清空、科目（英文）與主題（時態）保留',
    await c.eval(`document.getElementById('addModal').classList.contains('on') && document.getElementById('fQuestion').value==='' && (document.querySelector('#fSubject .chip.on')||{}).textContent==='英文' && document.getElementById('fTopicsChips').textContent.includes('時態')`));
  // 保留下來的主題是設計行為；下一題換科目，先把它拿掉
  await c.eval(`(()=>{const x=[...document.querySelectorAll('#fTopicsChips .chip span')].find(s=>s.textContent==='×'); if(x) x.click(); return 1})()`);
  await pickSubject('國文');
  await fill({ fChapter: '字音', fQuestion: 'Q3 走查題：「龜」裂的讀音？', fMyAns: 'ㄍㄨㄟ', fAns: 'ㄐㄩㄣ', fSource: '走查卷B' });
  await clickBtn('#addModal .save-bar', '儲存', '續加');
  await c.until(`!document.getElementById('addModal').classList.contains('on')`, 4000);
  const db3 = await idb();
  ok('3.2 IndexedDB 共 3 題（實際 ' + (db3 || []).length + '），科目為 數學/英文/國文', (db3 || []).length === 3 && J((db3 || []).map((q) => q.subject).sort()) === J(['國文', '數學', '英文'].sort()), (db3 || []).map((q) => q.subject));
  // 填了一半按取消：要先確認，拒絕就不關（避免誤觸丟資料）
  await c.eval(`document.getElementById('fab').click()`);
  await c.until(`document.getElementById('addModal').classList.contains('on')`, 3000);
  await fill({ fQuestion: '打到一半的題目' });
  await c.eval(`window.__confirmAnswer=false; window.__confirms=[]; 1`);
  await clickBtn('#addModal .save-bar', '取消');
  const conf1 = await c.eval(`window.__confirms.slice()`);
  ok('3.3 有未存內容按取消會先詢問，選「否」視窗維持開啟（詢問 ' + conf1.length + ' 次）',
    conf1.length === 1 && conf1[0].includes('還沒儲存') && await c.eval(`document.getElementById('addModal').classList.contains('on') && document.getElementById('fQuestion').value==='打到一半的題目'`), conf1);
  await c.eval(`window.__confirmAnswer=true; 1`);
  await clickBtn('#addModal .save-bar', '取消');
  ok('3.4 選「是」才關閉，且沒有多存出一題（IndexedDB 仍 ' + ((await idb()) || []).length + ' 題）',
    await c.until(`!document.getElementById('addModal').classList.contains('on')`, 2000) && ((await idb()) || []).length === 3);

  /* ───────── 4 重新整理後資料還在 ───────── */
  console.log('\n[4 重新整理後資料還在]');
  await c.open(BASE);
  const c4 = await cards();
  ok('4.1 🔴 重新整理後列表仍有 3 題（實際 ' + c4.length + '）', c4.length === 3 && ['Q1', 'Q2', 'Q3'].every((k) => c4.some((t) => t.includes(k + ' 走查題'))), c4.map((t) => t.slice(0, 30)));
  ok('4.2 重新整理後照片從 IndexedDB Blob 還原、縮圖顯示得出來（寬 320）',
    await c.until(`(()=>{const i=[...document.querySelectorAll('#listArea .qcard')].find(e=>e.textContent.includes('Q1 走查題')); const im=i&&i.querySelector('img.thumb'); return !!im && im.src.startsWith('blob:') && im.complete && im.naturalWidth===320})()`, 5000));
  await clickCard('Q1 走查題');
  ok('4.3 點卡片開詳情：題目、我的答案、正解、詳解都在',
    await c.until(`(()=>{const v=document.getElementById('viewBody'); const t=v.textContent; return document.getElementById('viewModal').classList.contains('on') && t.includes('Q1 走查題') && t.includes('我的答案') && t.includes('正確答案') && t.includes('2^3=8')})()`, 3000));

  /* ───────── 5 編輯 ───────── */
  console.log('\n[5 編輯]');
  await clickBtn('#viewBody', '編輯');
  ok('5.1 編輯視窗帶入原資料（標題「編輯錯題」、題目原文、照片預覽）',
    await c.until(`document.getElementById('addModal').classList.contains('on') && document.getElementById('addTitle').textContent==='編輯錯題' && document.getElementById('fQuestion').value.includes('Q1 走查題') && document.getElementById('photoPreview').style.display==='block'`, 3000));
  await fill({ fQuestion: 'Q1 已編輯：log_2 8 = ?', fAns: '3（三）' });
  await clickBtn('#addModal .save-bar', '儲存', '續加');
  await c.until(`!document.getElementById('addModal').classList.contains('on')`, 4000);
  await toastHas('已更新');
  const all5 = (await idb()) || [];
  const r5 = all5.find((q) => q.id === (r1 && r1.id));
  ok('5.2 IndexedDB 同一筆（同 id）被更新，沒有多出新題（共 ' + all5.length + ' 題）',
    all5.length === 3 && !!r5 && r5.question === 'Q1 已編輯：log_2 8 = ?' && r5.ans === '3（三）', r5 && { q: r5.question, ans: r5.ans, n: all5.length });
  ok('5.3 編輯不會弄丟照片、建立時間與科目（照片 ' + (r5 && r5.image ? r5.image.size : 0) + ' bytes）',
    !!r5 && r5.image && r5.image.blob && r5.image.size === r1.image.size && r5.createdAt === r1.createdAt && r5.subject === '數學' && r5.updatedAt >= r1.updatedAt,
    r5 && { image: r5.image, createdAt: [r1.createdAt, r5.createdAt] });
  await c.open(BASE);
  const c5 = await cards();
  ok('5.4 重新整理後顯示編輯後的文字，舊文字不見了', c5.some((t) => t.includes('Q1 已編輯')) && !c5.some((t) => t.includes('Q1 走查題')), c5.map((t) => t.slice(0, 30)));

  /* ───────── 6 分類／篩選／搜尋 ───────── */
  console.log('\n[6 分類、篩選、搜尋]');
  await c.eval(`[...document.querySelectorAll('#subjFilter .chip')].find(e=>e.textContent.trim()==='英文').click()`);
  await c.until(`document.querySelectorAll('#listArea .qcard').length===1`, 3000);
  const sub6 = await c.eval(`[...document.querySelectorAll('#listArea .qcard')].map(e=>e.className)`);
  ok('6.1 科目篩選「英文」：只剩英文題（樣本 ' + sub6.length + ' 張）', sub6.length === 1 && sub6.every((cl) => cl.includes('s-英文')), sub6);
  ok('6.2 有篩選時出現「✖ 清除」', await c.eval(`getComputedStyle(document.getElementById('clearFilterBtn')).display!=='none'`));
  await c.open(BASE);
  const sub6b = await c.eval(`[...document.querySelectorAll('#listArea .qcard')].map(e=>e.className)`);
  ok('6.3 篩選條件重新整理後保留（仍只顯示英文，樣本 ' + sub6b.length + ' 張）', sub6b.length === 1 && sub6b[0].includes('s-英文'), sub6b);
  await c.eval(`document.getElementById('clearFilterBtn').click()`);
  ok('6.4 按清除回到全部 3 題', await c.until(`document.querySelectorAll('#listArea .qcard').length===3`, 3000), await c.eval(`document.querySelectorAll('#listArea .qcard').length`));
  await c.eval(`(()=>{const i=document.getElementById('listSearch'); i.value='走查卷B'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`);
  await c.until(`document.querySelectorAll('#listArea .qcard').length===2`, 3000);
  const s6 = await cards();
  ok('6.5 列表搜尋「走查卷B」（來源標籤）：命中 Q2、Q3 兩題（實際 ' + s6.length + '）', s6.length === 2 && s6.every((t) => t.includes('走查卷B')), s6.map((t) => t.slice(0, 30)));
  await c.eval(`document.getElementById('clearFilterBtn').click()`);
  await c.until(`document.querySelectorAll('#listArea .qcard').length===3`, 3000);
  await c.eval(`(()=>{document.getElementById('filterAdvBtn').click(); const s=document.getElementById('filterTopic'); s.value='時態'; s.dispatchEvent(new Event('change')); return 1})()`);
  await c.until(`document.querySelectorAll('#listArea .qcard').length===1`, 3000);
  const t6 = await cards();
  ok('6.6 主題篩選「時態」：只剩 Q2（實際 ' + t6.length + ' 張）', t6.length === 1 && t6[0].includes('Q2'), t6.map((t) => t.slice(0, 30)));
  ok('6.7 分組檢視的標題顯示「英文 ／ 時態（1）」', await c.eval(`document.getElementById('listArea').textContent.includes('英文　／　時態')`));
  await c.eval(`document.getElementById('clearFilterBtn').click()`);
  await c.until(`document.querySelectorAll('#listArea .qcard').length===3`, 3000);
  await c.eval(`document.querySelector('header .iconbtn[title="搜尋"]').click()`);
  await c.until(`document.getElementById('searchModal').classList.contains('on')`, 2000);
  await c.eval(`(()=>{const i=document.getElementById('searchInput'); i.value='went'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`);
  await c.until(`document.querySelectorAll('#searchResults .qcard').length>0`, 3000);
  const g6 = await c.eval(`[...document.querySelectorAll('#searchResults .qcard')].map(e=>e.textContent.replace(/\\s+/g,' ').slice(0,40))`);
  ok('6.8 全域搜尋「went」（正解欄）：找到 1 題 Q2（實際 ' + g6.length + '）', g6.length === 1 && g6[0].includes('Q2') && await c.eval(`document.getElementById('searchResults').textContent.includes('找到 1 題')`), g6);
  await clickBtn('#searchModal', '關閉');

  /* ───────── 7 複習 ───────── */
  console.log('\n[7 複習：連對 3 次畢業、答錯歸零]');
  const q1id = r1 && r1.id;
  const t0 = await today();
  const reviewOnce = async (answer, correct) => {
    await c.until(`[...document.querySelectorAll('#reviewArea button')].some(b=>b.textContent.includes('對答案'))`, 3000);
    await c.eval(`(()=>{const w=document.getElementById('reviewWrite'); if(w) w.value=${J(answer)}; return 1})()`);
    await clickBtn('#reviewArea', '對答案');
    await c.until(`[...document.querySelectorAll('#reviewArea button')].some(b=>b.textContent.includes('答對了'))`, 3000);
    const before = (await rec('Q1 已編輯')).reviewCount || 0;
    await clickBtn('#reviewArea', correct ? '答對了' : '還不會');
    await c.until(`window.__idbAll().then(a=>{const q=a.find(x=>x.id===${J(q1id)}); return q && (q.reviewCount||0) === ${before + 1}})`, 4000);
    return rec('Q1 已編輯');
  };
  await goTab('review');
  await c.until(`document.getElementById('page-review').classList.contains('on') && document.getElementById('reviewArea').textContent.includes('題')`, 3000);
  const head7 = await c.eval(`(document.getElementById('reviewArea').textContent.match(/第\\s*(\\d+)\\s*\\/\\s*(\\d+)\\s*題/)||[]).slice(1).map(Number)`);
  ok('7.1 複習頁「今日到期」佇列有 3 題（新加的題今天到期，實際 ' + J(head7) + '）', head7[0] === 1 && head7[1] === 3, head7);
  // 從詳情的「🔥 複習這題」進入單題複習，確保操作的是 Q1
  await goTab('list');
  await clickCard('Q1 已編輯');
  await c.until(`document.getElementById('viewModal').classList.contains('on')`, 2000);
  await clickBtn('#viewBody', '複習這題');
  ok('7.2 「複習這題」進入單題複習（第 1 / 1 題，題目是 Q1）',
    await c.until(`document.getElementById('page-review').classList.contains('on') && /第\\s*1\\s*\\/\\s*1\\s*題/.test(document.getElementById('reviewArea').textContent) && document.getElementById('reviewArea').textContent.includes('Q1 已編輯')`, 3000));
  await c.eval(`(()=>{document.getElementById('reviewWrite').value='3（三）'; return 1})()`);
  await clickBtn('#reviewArea', '對答案');
  ok('7.3 對答案：自己寫的和正解一致會標「✓ 和正解一致」，並提示連對 3 次畢業',
    await c.until(`document.getElementById('reviewArea').textContent.includes('和正解一致') && document.getElementById('reviewArea').textContent.includes('連對 3 次就畢業')`, 3000));
  // 已經在揭曉狀態：直接評分（第 1 次答對）
  await clickBtn('#reviewArea', '答對了');
  await c.until(`window.__idbAll().then(a=>(a.find(x=>x.id===${J(q1id)})||{}).reviewCount===1)`, 4000);
  let r7 = await rec('Q1 已編輯');
  ok('7.4 答對 1 次：連對 1、未畢業、下次複習＝3 天後（實際 ' + J({ streak: r7.streak, days: (r7.nextReview - t0) / DAY }) + '）',
    r7.streak === 1 && r7.mastered === false && r7.nextReview === t0 + 3 * DAY);
  r7 = await reviewOnce('3', true);
  ok('7.5 答對 2 次：連對 2、仍未畢業（實際 ' + J({ streak: r7.streak, mastered: r7.mastered }) + '）', r7.streak === 2 && r7.mastered === false);
  r7 = await reviewOnce('5', false);
  ok('7.6 答錯：連對歸零、卡關 +1、明天再複習（實際 ' + J({ streak: r7.streak, lapses: r7.lapses, days: (r7.nextReview - t0) / DAY }) + '）',
    r7.streak === 0 && r7.lapses === 1 && r7.mastered === false && r7.nextReview === t0 + 1 * DAY);
  r7 = await reviewOnce('3', true);
  const r7a = r7;
  r7 = await reviewOnce('3', true);
  const r7b = r7;
  ok('7.7 歸零後重新累計：答對 2 次仍未畢業（連對 ' + r7a.streak + '→' + r7b.streak + '）', r7a.streak === 1 && r7b.streak === 2 && r7b.mastered === false);
  r7 = await reviewOnce('3', true);
  ok('7.8 🔴 連對第 3 次畢業：精熟、14 天後回訪（實際 ' + J({ streak: r7.streak, mastered: r7.mastered, maint: r7.maint, days: (r7.nextReview - t0) / DAY }) + '）',
    r7.streak === 3 && r7.mastered === true && r7.maint === 0 && r7.nextReview === t0 + 14 * DAY);
  ok('7.9 畢業有提示「畢業」', await toastHas('畢業'));
  ok('7.10 複習次數累計正確（共評分 6 次，實際 ' + r7.reviewCount + '）', r7.reviewCount === 6);
  await c.open(BASE);
  const badge = await c.eval(`(()=>{const e=[...document.querySelectorAll('#listArea .qcard')].find(e=>e.textContent.includes('Q1 已編輯')); return e? e.querySelector('.top').textContent.replace(/\\s+/g,' ').trim() : null})()`);
  ok('7.11 重新整理後 Q1 卡片顯示「✓ 精熟」', !!badge && badge.includes('精熟'), badge);
  ok('7.12 錯題本頁顯示「今天 2 題待複習」（畢業題不再到期）', await c.eval(`document.getElementById('listMotivate').textContent.includes('今天 2 題待複習')`),
    await c.eval(`document.getElementById('listMotivate').textContent.replace(/\\s+/g,' ').trim()`));
  await goTab('review');
  await c.until(`/第\\s*1\\s*\\/\\s*\\d+\\s*題/.test(document.getElementById('reviewArea').textContent)`, 3000);
  const head7b = await c.eval(`(document.getElementById('reviewArea').textContent.match(/第\\s*(\\d+)\\s*\\/\\s*(\\d+)\\s*題/)||[]).slice(1).map(Number)`);
  ok('7.13 今日佇列剩 2 題且不含已畢業的 Q1（實際 ' + J(head7b) + '）', head7b[1] === 2 && !(await c.eval(`document.getElementById('reviewArea').textContent.includes('Q1 已編輯')`)), head7b);
  await goTab('stats');
  await c.until(`document.querySelectorAll('#statTop .stat').length===3`, 3000);
  const st7 = await c.eval(`[...document.querySelectorAll('#statTop .stat .n')].map(e=>+e.textContent)`);
  ok('7.14 統計頁：總錯題 3、待複習 2、已精熟 1（實際 ' + J(st7) + '）', J(st7) === J([3, 2, 1]), st7);

  /* ───────── 8 刪除 ───────── */
  console.log('\n[8 刪除（含確認）]');
  await goTab('list');
  await clickCard('Q3 走查題');
  await c.until(`document.getElementById('viewModal').classList.contains('on') && document.getElementById('viewBody').textContent.includes('Q3')`, 2000);
  await c.eval(`window.__confirmAnswer=false; window.__confirms=[]; 1`);
  await clickBtn('#viewBody', '刪除');
  await sleep(400);
  const conf8 = await c.eval(`window.__confirms.slice()`);
  ok('8.1 按刪除會先確認；選「否」資料不動（詢問 ' + conf8.length + ' 次、IndexedDB 仍 ' + ((await idb()) || []).length + ' 題）',
    conf8.length === 1 && conf8[0].includes('確定刪除') && ((await idb()) || []).length === 3, conf8);
  await c.eval(`window.__confirmAnswer=true; 1`);
  await clickBtn('#viewBody', '刪除');
  await c.until(`window.__idbAll().then(a=>a.length===2)`, 4000);
  const db8 = (await idb()) || [];
  ok('8.2 選「是」：IndexedDB 剩 2 題且 Q3 不在（實際 ' + db8.length + '）', db8.length === 2 && !db8.some((q) => (q.question || '').includes('Q3')), db8.map((q) => q.question.slice(0, 12)));
  ok('8.3 列表剩 2 張卡且沒有 Q3', await c.until(`document.querySelectorAll('#listArea .qcard').length===2 && !document.getElementById('listArea').textContent.includes('Q3')`, 3000));
  await c.open(BASE);
  const c8 = await cards();
  ok('8.4 🔴 重新整理後 Q3 不會復活（列表 ' + c8.length + ' 張）', c8.length === 2 && !c8.some((t) => t.includes('Q3')), c8.map((t) => t.slice(0, 30)));

  /* ───────── 9 列印 ───────── */
  console.log('\n[9 列印錯題本]');
  await goTab('settings');
  await clickBtn('#page-settings', '完整版');
  await c.until(`window.__prints>0`, 3000);
  const pq = await c.eval(`document.querySelectorAll('#printArea .pq').length`);
  ok('9.1 列印完整版：產生 2 題並叫出列印（實際 ' + pq + ' 題、print 呼叫 ' + await c.eval(`window.__prints`) + ' 次）', pq === 2 && await c.eval(`window.__prints`) === 1);
  ok('9.2 列印內容含正解與照片', await c.eval(`document.getElementById('printArea').textContent.includes('正解') && document.querySelectorAll('#printArea img').length===1`));

  /* ───────── 10 匯出 → 清空 → 匯入 ───────── */
  console.log('\n[10 匯出 → 清空 → 匯入（往返一致）]');
  const snap = ((await idb()) || []).sort((a, b) => a.id.localeCompare(b.id));
  const snapPhoto = await c.eval(`window.__idbImage(${J(q1id)})`);
  await clickBtn('#page-settings', '匯出備份');
  await c.until(`window.__downloads.length>0 && !window.__downloads[0].pending`, 5000);
  const dl = await c.eval(`window.__downloads[0]`);
  let exp = null; try { exp = JSON.parse(dl.text); } catch {}
  ok('10.1 匯出檔名＝錯題備份_日期.json，內容 2 題（實際 ' + (exp && exp.questions ? exp.questions.length : 'parse 失敗') + '）',
    !!exp && /^錯題備份_\d{4}-\d{2}-\d{2}\.json$/.test(dl.name) && exp.questions.length === 2, { name: dl.name, err: dl.err });
  const expQ1 = exp && exp.questions.find((q) => q.id === q1id);
  ok('10.2 匯出的照片是 JPEG dataURL，且與 IndexedDB 位元組一致（' + (expQ1 && expQ1.image ? expQ1.image.length : 0) + ' 字）',
    !!expQ1 && typeof expQ1.image === 'string' && expQ1.image.startsWith('data:image/jpeg') && expQ1.image === snapPhoto);
  ok('10.3 匯出後記錄備份時間（設定頁顯示「今天已備份」）', await c.until(`document.getElementById('backupInfo').textContent.includes('今天已備份')`, 3000));
  await c.eval(`window.__confirmAnswer=true; window.__confirms=[]; 1`);
  await clickBtn('#page-settings', '清空所有資料');
  await c.until(`window.__idbAll().then(a=>a && a.length===0)`, 4000);
  const conf10 = await c.eval(`window.__confirms.slice()`);
  ok('10.4 清空要確認兩次，確認後 IndexedDB 為 0 筆（詢問 ' + conf10.length + ' 次）', conf10.length === 2 && ((await idb()) || [1]).length === 0, conf10);
  await c.open(BASE);
  ok('10.5 清空後重新整理仍是空的（回到空狀態）', await c.eval(`document.getElementById('listArea').textContent.includes('開始建立你的錯題本')`) && ((await idb()) || [1]).length === 0);
  const backupFile = path.join(profile, 'backup-roundtrip.json');
  await writeFile(backupFile, dl.text || '');
  await goTab('settings');
  await c.setFile('#importFile', backupFile);
  await c.until(`window.__idbAll().then(a=>a && a.length===2)`, 6000);
  ok('10.6 匯入提示「新增 2 題」', await toastHas('新增 2 題'), await c.eval(`document.getElementById('toast').textContent`));
  const back = ((await idb()) || []).sort((a, b) => a.id.localeCompare(b.id));
  const FIELDS = ['id', 'subject', 'chapter', 'topics', 'question', 'myAns', 'ans', 'explain', 'source', 'diff', 'streak', 'lapses', 'mastered', 'maint', 'reviewCount', 'nextReview', 'createdAt', 'updatedAt', 'image'];
  // 匯入會把「從沒複習過」題目缺的欄位補成預設值（lapses 缺→0、maint 缺→null），語意相同，不算差異
  const normF = (f, v) => (v === undefined ? (f === 'lapses' ? 0 : null) : v);
  const diffs = [];
  for (let i = 0; i < Math.max(snap.length, back.length); i++) {
    for (const f of FIELDS) {
      if (J(normF(f, snap[i] && snap[i][f])) !== J(normF(f, back[i] && back[i][f]))) diffs.push({ id: snap[i] && snap[i].id, f, before: snap[i] && snap[i][f], after: back[i] && back[i][f] });
    }
  }
  ok('10.7 🔴 匯入後 ' + back.length + ' 題 × ' + FIELDS.length + ' 欄與清空前逐欄一致（含複習進度、照片大小）', snap.length === 2 && back.length === 2 && diffs.length === 0, diffs.slice(0, 4));
  const backPhoto = await c.eval(`window.__idbImage(${J(q1id)})`);
  ok('10.8 照片位元組完全還原（dataURL 長度 ' + (backPhoto || '').length + '）', !!backPhoto && backPhoto === snapPhoto);
  await c.open(BASE);
  const c10 = await cards();
  ok('10.9 匯入後重新整理：列表 2 題、Q1 仍是精熟、縮圖顯示得出來',
    c10.length === 2 && c10.some((t) => t.includes('Q1 已編輯') && t.includes('精熟')) &&
    await c.until(`(()=>{const im=document.querySelector('#listArea .qcard img.thumb'); return !!im && im.complete && im.naturalWidth===320})()`, 5000), c10.map((t) => t.slice(0, 30)));
  await goTab('settings');
  await c.setFile('#importFile', backupFile);
  await toastHas('略過');
  const db10 = (await idb()) || [];
  ok('10.10 同一份備份再匯入一次：不會重複（仍 ' + db10.length + ' 題，提示略過 2）', db10.length === 2 && await c.eval(`document.getElementById('toast').textContent.includes('略過 2')`),
    await c.eval(`document.getElementById('toast').textContent`));

  /* ───────── 11 版面 ───────── */
  console.log('\n[11 版面：手機寬度]');
  for (const w of [360, 390]) {
    await c.width(w);
    await c.open(BASE);
    const n = await c.eval(`document.querySelectorAll('#listArea .qcard').length`);
    ok(`11.${w}a ${w}px 錯題本頁（${n} 張卡）沒有水平捲動`, n === 2 && await c.eval(`document.documentElement.scrollWidth <= window.innerWidth + 1`),
      await c.eval(`[document.documentElement.scrollWidth, window.innerWidth]`));
    await goTab('review');
    await c.until(`document.getElementById('reviewArea').children.length>0`, 3000);
    ok(`11.${w}b ${w}px 複習頁沒有水平捲動`, await c.eval(`document.documentElement.scrollWidth <= window.innerWidth + 1`),
      await c.eval(`[document.documentElement.scrollWidth, window.innerWidth]`));
    await goTab('list');
    await c.eval(`document.getElementById('fab').click()`);
    await c.until(`document.getElementById('addModal').classList.contains('on')`, 2000);
    ok(`11.${w}c ${w}px 新增視窗沒有水平溢出`, await c.eval(`(()=>{const m=document.querySelector('#addModal .modal'); return document.documentElement.scrollWidth <= window.innerWidth + 1 && m.scrollWidth <= m.clientWidth + 1})()`),
      await c.eval(`(()=>{const m=document.querySelector('#addModal .modal'); return [document.documentElement.scrollWidth, window.innerWidth, m.scrollWidth, m.clientWidth]})()`));
    await clickBtn('#addModal .save-bar', '取消');
  }
  await c.width(390);

  /* ───────── 12 錯誤與連線 ───────── */
  console.log('\n[12 沒有錯誤、沒有意外的對外連線]');
  ok('12.1 沒有未捕捉的 JS 例外（' + c.errors.length + '）', c.errors.length === 0, c.errors.slice(0, 3));
  ok('12.2 沒有 console.error（' + c.consoleErrors.length + '）', c.consoleErrors.length === 0, c.consoleErrors.slice(0, 3));
  ok('12.3 本機資源沒有 404（' + served404.length + '）', served404.length === 0 && c.badResponses.length === 0, { served404, bad: c.badResponses.slice(0, 3) });
  const hosts = [...new Set(c.requests.filter((u) => /^https?:/i.test(u)).map((u) => new URL(u).hostname))];
  const unexpected = hosts.filter((h) => h !== '127.0.0.1');
  ok('12.4 全程只連本機（共 ' + c.requests.length + ' 個請求；主機：' + hosts.join(', ') + '）', c.requests.length > 0 && unexpected.length === 0, unexpected);
} catch (e) {
  fail++;
  console.log('  FAIL 測試程式本身出錯：' + (e && e.stack || e));
} finally {
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + '　通過 ' + pass + ' 項，失敗 ' + fail + ' 項');
  await cleanup();
  process.exit(fail ? 1 : 0);
}
