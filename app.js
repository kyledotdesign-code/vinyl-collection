/* -------------------------------------------------------
   Vinyl Collection — reliable artwork (direct-first + wiki resolve + proxy fallback)
   Works with either:
   - #view-scroll / #view-grid / #sort / #shuffle / #statsBtn
   - or camelCase versions (#viewScroll, #viewGrid, #sortSelect, #btnShuffle, #btnStats)
-------------------------------------------------------- */

// Replace with YOUR Apps Script Web App URL from step 1
const APP_SCRIPT_URL = "PASTE_YOUR_WEB_APP_URL_HERE";

// ----- UPC Scanner (Quagga2) + Sheet append ----- //
const scanEls = {
  dialog: document.getElementById('scanDialog'),
  viewport: document.getElementById('scannerViewport'),
  openBtn: document.getElementById('scanBtn'),
  closeBtn: document.getElementById('scanClose'),
  againBtn: document.getElementById('scanAgain'),
  saveBtn: document.getElementById('scanSave'),
  resultWrap: document.getElementById('scanResult'),
  upcText: document.getElementById('upcText'),
  upc: document.getElementById('scanUPC'),
  artist: document.getElementById('scanArtist'),
  title: document.getElementById('scanTitle'),
  notes: document.getElementById('scanNotes'),
  cover: document.getElementById('scanCover'),
};

let scanning = false;
let lastDetected = 0;

function startScanner(){
  if (scanning) return;
  scanning = true;
  scanEls.resultWrap.hidden = true;

  const readers = [
    "upc_reader", "upc_e_reader",
    "ean_reader", "ean_8_reader" // many UPCs are EAN-13
  ];

  Quagga.init({
    inputStream: {
      type: "LiveStream",
      target: scanEls.viewport,
      constraints: {
        facingMode: "environment",
        // Safari iPhone likes explicit ideal values:
        width: { ideal: 1280 },
        height:{ ideal: 720 }
      }
    },
    locator: { halfSample: true, patchSize: "medium" },
    decoder: { readers },
    numOfWorkers: navigator.hardwareConcurrency ? Math.max(2, navigator.hardwareConcurrency - 1) : 2,
  }, (err) => {
    if (err) {
      console.error(err);
      alert("Camera error. Check permissions and try again.");
      scanning = false;
      return;
    }
    Quagga.start();
  });

  Quagga.onDetected(onDetected);
}

function stopScanner(){
  try { Quagga.offDetected(onDetected); } catch(e){}
  try { Quagga.stop(); } catch(e){}
  scanning = false;
}

function onDetected(res){
  const now = Date.now();
  if (now - lastDetected < 1500) return; // debounce
  lastDetected = now;

  const code = res?.codeResult?.code || "";
  if (!code) return;

  // basic UPC/EAN sanity
  if (!/^\d{8,14}$/.test(code)) return;

  // haptic
  if (navigator.vibrate) navigator.vibrate([60,20,60]);

  // Show the mini form
  scanEls.upc.value = code;
  scanEls.upcText.textContent = code;
  scanEls.resultWrap.hidden = false;

  // Pause camera while user fills form
  stopScanner();
}

async function saveScanned(){
  const rec = {
    artist: scanEls.artist.value.trim(),
    title:  scanEls.title.value.trim(),
    notes:  scanEls.notes.value.trim(),
    cover:  scanEls.cover.value.trim(),
    upc:    scanEls.upc.value.trim(),
  };
  if (!rec.artist || !rec.title) {
    alert("Please fill Artist and Title.");
    return;
  }

  // 1) Optimistically add to page immediately
  const newRec = {
    artist: rec.artist,
    title: rec.title,
    notes: rec.notes,
    genre: "",               // you can fill later or auto-resolve if you want
    coverRaw: rec.cover,
    cover: rec.cover || "",  // your existing rendering already handles empty covers
  };
  // Push into your current in-memory list and re-render
  if (window.state && Array.isArray(state.all)) {
    state.all.unshift(newRec);
    state.filtered = [...state.all];
    if (typeof applySort === 'function') applySort();
    if (typeof render === 'function') render();
  }

  // 2) Append to Google Sheet via Apps Script (no-cors; best-effort)
  if (APP_SCRIPT_URL && APP_SCRIPT_URL.startsWith('https')) {
    try {
      await fetch(APP_SCRIPT_URL, {
        method: 'POST',
        mode: 'no-cors', // avoid CORS preflight; response will be opaque
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(rec)
      });
    } catch (e) {
      console.warn('Sheet write failed (network/CORS). The item still appears locally.', e);
    }
  }

  // Reset form & close
  scanEls.artist.value = '';
  scanEls.title.value = '';
  scanEls.notes.value = '';
  scanEls.cover.value = '';
  scanEls.upc.value = '';
  scanEls.resultWrap.hidden = true;
  scanEls.dialog.close();
}

scanEls.openBtn?.addEventListener('click', () => {
  scanEls.dialog.showModal();
  startScanner();
});

scanEls.closeBtn?.addEventListener('click', () => {
  scanEls.dialog.close();
  stopScanner();
});

scanEls.againBtn?.addEventListener('click', () => {
  scanEls.resultWrap.hidden = true;
  startScanner();
});

scanEls.saveBtn?.addEventListener('click', saveScanned);


// 0) CONFIG
const SHEET_CSV =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?output=csv";

const HEADER_ALIASES = {
  title:    ["title","album","record","release"],
  artist:   ["artist","artists","band"],
  genre:    ["genre","genres","style","category"],
  notes:    ["notes","special notes","comment","comments","description"],
  cover:    ["album artwork","artwork","cover","cover url","image","art","art url","artwork url"],
  altCover: ["alt artwork","alt cover","alternate artwork","alternate cover"]
};

// calm placeholder so the UI never looks broken
const PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <defs><radialGradient id="g" cx="50%" cy="50%" r="60%">
      <stop offset="0%" stop-color="#2a3140"/><stop offset="100%" stop-color="#121722"/>
    </radialGradient></defs>
    <rect width="100" height="100" rx="10" fill="url(#g)"/>
    <circle cx="50" cy="50" r="8" fill="#0a0f17" stroke="#444e60" stroke-width="2"/>
    <circle cx="50" cy="50" r="2.5" fill="#ddd"/>
  </svg>`);

// 1) ELEMENTS (robust selectors to match either version of the HTML)
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];

const els = {
  header:     $('#siteHeader') || $('.site-header') || document.body,
  search:     $('#search'),
  viewScroll: $('#view-scroll') || $('#viewScroll'),
  viewGrid:   $('#view-grid')   || $('#viewGrid'),
  sort:       $('#sort')        || $('#sortSelect'),
  shuffle:    $('#shuffle')     || $('#btnShuffle'),
  statsBtn:   $('#statsBtn')    || $('#btnStats'),
  scroller:   $('#scroller'),
  grid:       $('#grid'),
  statsDlg:   $('#statsModal'),
  statsBody:  $('#statsBody'),
  tpl:        $('#cardTpl')
};

// header offset for fixed header (if your CSS uses --header-h)
function applyHeaderOffset(){
  const h = els.header?.offsetHeight || 96;
  document.body.style.setProperty('--header-h', `${h}px`);
  document.body.classList.add('has-fixed-header');
}
window.addEventListener('load', applyHeaderOffset);
window.addEventListener('resize', applyHeaderOffset);

// 2) STATE
const state = { all: [], filtered: [], view: 'scroll', sortKey: 'title' };

// 3) CSV helpers
function pick(obj, synonyms){
  const keys = Object.keys(obj);
  for (const key of synonyms){
    const hit = keys.find(h => h.trim().toLowerCase() === key);
    if (hit && String(obj[hit]).trim()) return String(obj[hit]).trim();
  }
  return "";
}
function parseCSV(text){
  const rows = [];
  let cur = [''];
  let i = 0, inQuotes = false;
  for (; i < text.length; i++){
    const c = text[i];
    if (c === '"'){
      if (inQuotes && text[i+1] === '"'){ cur[cur.length-1] += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes){
      cur.push('');
    } else if ((c === '\n' || c === '\r') && !inQuotes){
      if(cur.length>1 || cur[0] !== '') rows.push(cur);
      cur = [''];
      if (c === '\r' && text[i+1]==='\n') i++;
    } else {
      cur[cur.length-1] += c;
    }
  }
  if(cur.length>1 || cur[0] !== '') rows.push(cur);
  if(rows.length === 0) return { header: [], data: [] };
  const header = rows[0].map(h => h.trim());
  const data = rows.slice(1).map(r => {
    const o = {};
    header.forEach((h, idx)=> o[h] = (r[idx] ?? '').trim());
    return o;
  });
  return { header, data };
}

// 4) IMAGE RESOLUTION (direct-first → proxy fallback → placeholder)
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i;
const isImageUrl = (u) => IMG_EXT_RE.test(u||"");
const isWikiPage = (u) => /^https?:\/\/[^/]*wikipedia\.org\/wiki\/[^]+/i.test(u||"");

// weserv format must be url=ssl:host/path (and the whole thing URL-encoded)
function weserv(url){
  const stripped = url.replace(/^https?:\/\//,'');
  return `https://images.weserv.nl/?url=${encodeURIComponent('ssl:' + stripped)}&w=1000&h=1000&fit=cover&output=webp&q=85`;
}

async function wikiLeadImage(pageUrl){
  try{
    const m = pageUrl.match(/\/wiki\/([^?#]+)/i);
    if(!m) return "";
    const title = decodeURIComponent(m[1]);
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    if(!r.ok) return "";
    const j = await r.json();
    return j?.originalimage?.source || j?.thumbnail?.source || "";
  }catch{ return ""; }
}

// choose best image from Album Artwork / Alt Artwork / Wikipedia page
async function resolveImageUrl(input){
  const u = (input||"").trim();
  if(!u) return { direct:"", proxy:"" };

  if(isImageUrl(u)){
    return { direct: u, proxy: weserv(u) };
  }
  if(isWikiPage(u)){
    const lead = await wikiLeadImage(u);
    if(lead) return { direct: lead, proxy: weserv(lead) };
  }
  return { direct:"", proxy:"" }; // non-image page (Apple/Spotify/etc) → no scrape
}

// 5) LOADING
function showStatus(msg){
  let el = $('#status');
  if(!el){
    el = document.createElement('div');
    el.id = 'status';
    el.style.cssText = "margin:16px; padding:12px 14px; border:1px solid #1b2430; background:#0e141c; color:#eaf0f8; border-radius:12px;";
    $('main').prepend(el);
  }
  el.textContent = msg;
}

async function loadFromSheet(){
  try{
    const res  = await fetch(SHEET_CSV, { cache: "no-store" });
    const text = await res.text();
    if(text.trim().startsWith("<")){
      showStatus("Your Google Sheet link is not CSV. Publish to web → CSV (URL ends with output=csv).");
      return;
    }

    const { data } = parseCSV(text);
    const normalized = data.map(r => {
      const title     = pick(r, HEADER_ALIASES.title);
      const artist    = pick(r, HEADER_ALIASES.artist);
      const genre     = pick(r, HEADER_ALIASES.genre);
      const notes     = pick(r, HEADER_ALIASES.notes);
      const coverRaw  = pick(r, HEADER_ALIASES.cover);
      const altRaw    = pick(r, HEADER_ALIASES.altCover);
      const input     = coverRaw || altRaw || "";
      return { title, artist, genre, notes, input, direct:"", proxy:"" };
    }).filter(x => x.title || x.artist);

    state.all = normalized;
    state.filtered = [...normalized];
    applySort();
    render();                  // render quickly with placeholders
    $('#status')?.remove();

    // hydrate images progressively
    await hydrateImages(state.all, 8);
  }catch(e){
    console.error(e);
    showStatus("Couldn’t load your Google Sheet. Check the URL or try again.");
  }
}

// progressively resolve covers; limit concurrent work
async function hydrateImages(recs, limit=8){
  let idx = 0;
  async function worker(){
    while(idx < recs.length){
      const i = idx++;
      const rec = recs[i];

      // resolve from Album Artwork / Alt Artwork / Wikipedia
      const { direct, proxy } = await resolveImageUrl(rec.input);
      rec.direct = direct; rec.proxy = proxy;

      paintCover(i, direct, proxy);
    }
  }
  await Promise.all(Array.from({length:Math.max(1,Math.min(limit,recs.length))}, worker));
}

// set <img> with direct → proxy → placeholder failover
function paintCover(i, directUrl, proxyUrl){
  const roots = [els.scroller, els.grid];
  for(const root of roots){
    if(!root) continue;
    const card = root.querySelector(`.card[data-idx="${i}"]`);
    if(!card) continue;
    const img = card.querySelector('.cover');
    let triedProxy = false;

    img.onerror = ()=>{
      if(!triedProxy && proxyUrl){
        triedProxy = true;
        img.src = proxyUrl;
      }else{
        img.src = PLACEHOLDER;
      }
      card.classList.add('loaded');
    };
    img.onload  = ()=> card.classList.add('loaded');

    img.referrerPolicy = "no-referrer";     // avoid hotlink referrer issues
    img.src = directUrl || proxyUrl || PLACEHOLDER;
  }
}

// 6) RENDERING
function createCard(rec, idx){
  const tplEl = els.tpl && els.tpl.content ? els.tpl.content : null;
  if(!tplEl) throw new Error("Missing #cardTpl <template> in index.html");

  const tpl = tplEl.cloneNode(true);
  const card   = tpl.querySelector('.card');
  const img    = tpl.querySelector('.cover');
  const titleE = tpl.querySelector('.title');
  const artistE= tpl.querySelector('.artist');
  const genreE = tpl.querySelector('.genre');
  const notesE = tpl.querySelector('.notes');
  const capT   = tpl.querySelector('.caption-title');
  const capA   = tpl.querySelector('.caption-artist');

  const safeTitle  = rec.title  || "Untitled";
  const safeArtist = rec.artist || "Unknown Artist";

  card.dataset.idx   = idx;
  img.alt            = `${safeTitle} — ${safeArtist}`;
  img.src            = PLACEHOLDER;        // real art swapped in later
  capT.textContent   = safeTitle;
  capA.textContent   = safeArtist;
  titleE.textContent = safeTitle;
  artistE.textContent= safeArtist;
  if(genreE) genreE.innerHTML = rec.genre ? `<span class="chip">${rec.genre}</span>` : "";
  if(notesE) notesE.textContent = rec.notes || "";

  card.addEventListener('click', (e)=>{
    if(e.target.closest('.nav-arrow')) return;
    card.classList.toggle('flipped');
  });

  return tpl;
}

function renderScroll(){
  els.scroller.innerHTML = "";
  state.filtered.forEach((rec,i) => els.scroller.appendChild(createCard(rec,i)));
  els.scroller.scrollLeft = 0;
}
function renderGrid(){
  els.grid.innerHTML = "";
  state.filtered.forEach((rec,i) => els.grid.appendChild(createCard(rec,i)));
}
function render(){
  const isScroll = state.view === 'scroll';
  $('.view-scroll')?.classList.toggle('active', isScroll);
  $('.view-grid') ?.classList.toggle('active', !isScroll);
  if(isScroll){ renderScroll(); toggleArrows(true); }
  else        { renderGrid();   toggleArrows(false); }
}

// 7) UI
function toggleArrows(show){ $$('.nav-arrow').forEach(b=> b.style.display = show ? '' : 'none'); }
function smoothScrollBy(px){ els.scroller?.scrollBy({ left: px, behavior: 'smooth' }); }
$('.nav-arrow.left') ?.addEventListener('click', ()=> smoothScrollBy(-Math.round(els.scroller.clientWidth*0.9)));
$('.nav-arrow.right')?.addEventListener('click', ()=> smoothScrollBy(Math.round(els.scroller.clientWidth*0.9)));

els.viewScroll && els.viewScroll.addEventListener('click', ()=>{
  state.view = 'scroll';
  els.viewScroll.classList.add('active');
  els.viewGrid?.classList.remove('active');
  render();
});
els.viewGrid && els.viewGrid.addEventListener('click', ()=>{
  state.view = 'grid';
  els.viewGrid.classList.add('active');
  els.viewScroll?.classList.remove('active');
  render();
});

els.search && els.search.addEventListener('input', (e)=>{
  const q = e.target.value.trim().toLowerCase();
  state.filtered = state.all.filter(r=>{
    const hay = `${r.title} ${r.artist} ${r.genre} ${r.notes}`.toLowerCase();
    return hay.includes(q);
  });
  applySort(); render();
});

function setSortKey(key){ state.sortKey = key; applySort(); render(); }
function applySort(){
  const k = state.sortKey;
  state.filtered.sort((a,b)=>{
    const A = (a[k]||"").toLowerCase();
    const B = (b[k]||"").toLowerCase();
    return A.localeCompare(B);
  });
}
els.sort && els.sort.addEventListener('change', ()=> setSortKey(els.sort.value || 'title'));

els.shuffle && els.shuffle.addEventListener('click', ()=>{
  for(let i=state.filtered.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [state.filtered[i], state.filtered[j]] = [state.filtered[j], state.filtered[i]];
  }
  render();
});

// 8) STATS
function buildStats(recs){
  const total = recs.length;
  const artistMap = new Map();
  const genreMap  = new Map();
  for(const r of recs){
    if(r.artist) artistMap.set(r.artist, (artistMap.get(r.artist)||0)+1);
    if(r.genre){
      for(const g of String(r.genre).split(/[\/,&]| and /i).map(s=>s.trim()).filter(Boolean)){
        genreMap.set(g, (genreMap.get(g)||0)+1);
      }
    }
  }
  const topArtists = [...artistMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12);
  const topGenres  = [...genreMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,14);
  return { total, uniqArtists: artistMap.size, topArtists, topGenres };
}
function pills(list){ return list.map(([t,n])=>`<span class="chip">${t} • ${n}</span>`).join(""); }
function openStats(){
  const s = buildStats(state.filtered);
  els.statsBody.innerHTML = `
    <div class="stat-grid">
      <div class="stat-tile"><div>Total Albums</div><div class="stat-big">${s.total}</div></div>
      <div class="stat-tile"><div>Unique Artists</div><div class="stat-big">${s.uniqArtists}</div></div>
      <div class="stat-tile"><div>Total Genres</div><div class="stat-big">${s.topGenres.length}</div></div>
    </div>
    <h3>Top Artists</h3><div class="chips">${pills(s.topArtists) || '<span class="chip">No data</span>'}</div>
    <h3>Top Genres</h3><div class="chips">${pills(s.topGenres)  || '<span class="chip">No data</span>'}</div>
  `;
  els.statsDlg.showModal();
}
els.statsBtn && els.statsBtn.addEventListener('click', openStats);
$('#statsModal .dialog-close')?.addEventListener('click', ()=> els.statsDlg.close());

// 9) GO
loadFromSheet();
applySort();
