/* =========================================
   Vinyl Collection — app.js (one-card arrows)
   ========================================= */

const SHEET_CSV =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?output=csv";

const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwmcZPZbg3-Cfev8OTt_YGIsrTZ3Lb_BZ2xQ5bRxh9Hpy9OvkYkOqeubtl1MQ4OGqZAJw/exec";

const $ = (s, r = document) => r.querySelector(s);

/* -------- Elements -------- */
const els = {
  header: $('.site-header'),
  openSearch: $('#openSearch'),
  closeSearch: $('#closeSearch'),
  search: $('#search'),

  viewScrollBtn: $('#view-scroll'),
  viewGridBtn: $('#view-grid'),
  sort: $('#sort'),
  shuffle: $('#shuffle'),
  refresh: $('#refresh'),

  scroller: $('#scroller'),
  grid: $('#grid'),
  prev: $('#scrollPrev'),
  next: $('#scrollNext'),

  statsBtn: $('#statsBtn'),
  statsModal: $('#statsModal'),
  statsBody: $('#statsBody'),

  chipBar: $('#chipBar'),
  cardTpl: $('#cardTpl'),

  fab: $('#fab'),
  fabMenu: $('#fabMenu'),
  fabScan: $('#fabScan'),
  fabEnter: $('#fabEnter'),

  scanModal: $('#scanModal'),
  camera: $('#camera'),
  scanStatus: $('#scanStatus'),
  formArtist: $('#formArtist'),
  formTitle: $('#formTitle'),
  formGenre: $('#formGenre'),
  formNotes: $('#formNotes'),
  formUPC: $('#formUPC'),
  saveBtn: $('#saveBtn'),

  enterUPCModal: $('#enterUPCModal'),
  enterUPCInput: $('#enterUPCInput'),
  enterUPCGo: $('#enterUPCGo'),

  toastWrap: $('#toastWrap'),

  scrollView: $('#scrollView'),
  gridView: $('#gridView'),
};

/* -------- State -------- */
const state = {
  all: [],
  filtered: [],
  sortKey: 'title',
  view: 'scroll',
  filter: { query: '', genre: null, artist: null },
  lastRefresh: { before: 0 }
};
window.state = state;

/* -------- Utilities -------- */
function toast(message, actions = []) {
  const t = document.createElement('div');
  t.className = 'toast';
  const msg = document.createElement('div');
  msg.textContent = message;
  t.appendChild(msg);

  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'actions';
    actions.forEach(a => {
      const b = document.createElement('button');
      b.className = 'link';
      b.textContent = a.label;
      b.addEventListener('click', () => { try { a.onClick?.(); } finally { t.remove(); }});
      row.appendChild(b);
    });
    t.appendChild(row);
  }
  els.toastWrap.appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

// Haptics: Android uses vibrate; iOS fallback = tiny click sound (on Save only)
async function haptic(pattern, {audioFallback=false} = {}){
  try{
    if (navigator.vibrate) { navigator.vibrate(pattern); return; }
    if (audioFallback){
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = haptic._ctx || (haptic._ctx = new Ctx());
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square'; o.frequency.value = 120;
      g.gain.value = 0.0001; o.connect(g); g.connect(ctx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + 0.08);
      o.stop(ctx.currentTime + 0.09);
    }
  }catch{}
}

function csvEscape(s){ return /[",\n]/.test(s) ? `"${String(s).replace(/"/g,'""')}"` : String(s); }

/* -------- CSV Parser -------- */
function parseCSV(text){
  const rows = [];
  let cur = [''];
  let i = 0, inQuotes = false;
  for (; i < text.length; i++){
    const c = text[i];
    if (c === '"'){
      if (inQuotes && text[i+1] === '"'){ cur[cur.length-1] += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes){ cur.push(''); }
    else if ((c === '\n' || c === '\r') && !inQuotes){
      rows.push(cur); cur = ['']; if (c === '\r' && text[i+1] === '\n') i++;
    } else { cur[cur.length-1] += c; }
  }
  if (cur.length > 1 || cur[0] !== '') rows.push(cur);
  if (!rows.length) return { header: [], data: [] };
  const header = rows[0].map(h => h.trim());
  const data = rows.slice(1).map(r => {
    const o = {}; header.forEach((h, idx)=> o[h] = (r[idx] ?? '').trim()); return o;
  });
  return { header, data };
}

/* -------- Header picking -------- */
const HEADER_ALIASES = {
  title:  ["title","album","record","release"],
  artist: ["artist","artists","band"],
  genre:  ["genre","genres","style","category"],
  notes:  ["notes","special notes","comment","comments","description"],
  cover:  ["album artwork","artwork","cover","cover url","image","art","art url","artwork url"],
  alt:    ["alt artwork","alt image","alt cover","alt art"],
  upc:    ["upc","barcode"],
};
function pickField(row, keys){
  const map = {};
  Object.keys(row).forEach(k => map[k.trim().toLowerCase()] = k);
  for(const key of keys){
    if (map[key]) {
      const val = row[map[key]];
      if (val && String(val).trim()) return String(val).trim();
    }
  }
  return "";
}

/* -------- Artwork helpers -------- */
function looksLikeImage(u){ return /\.(png|jpe?g|webp|gif|avif)(\?|#|$)/i.test(u||""); }
function wsrv(url){ return `https://wsrv.nl/?url=${encodeURIComponent(url)}&w=1000&h=1000&fit=cover&output=webp&q=85`; }

async function fromWikipediaPage(pageUrl){
  const m = pageUrl.match(/https?:\/\/(?:\w+\.)?wikipedia\.org\/wiki\/([^?#]+)/i);
  if(!m) return "";
  const title = decodeURIComponent(m[1]);
  try{
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    if(!r.ok) return "";
    const j = await r.json();
    return j?.originalimage?.source || j?.thumbnail?.source || "";
  }catch{ return ""; }
}
function fromWikipediaFile(fileUrl){
  const m = fileUrl.match(/wikipedia\.org\/wiki\/File:(.+)$/i);
  if(!m) return "";
  const filename = decodeURIComponent(m[1]);
  return `https://en.wikipedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}`;
}
async function wikipediaSearchImage(q){
  try{
    const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&origin=*&list=search&srsearch=${encodeURIComponent(q)}&utf8=&format=json&srlimit=1`);
    if(!r.ok) return "";
    const j = await r.json();
    const page = j?.query?.search?.[0];
    if(!page) return "";
    return await fromWikipediaPage(`https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`);
  }catch{ return ""; }
}

async function chooseCover(coverRaw, altRaw, title="", artist=""){
  const candidate = coverRaw || altRaw || "";
  if (!candidate){
    const img = await wikipediaSearchImage(`${title} ${artist} album cover`);
    return img ? wsrv(img) : "";
  }
  if (/wikipedia\.org\/wiki\/File:/i.test(candidate)){
    const direct = fromWikipediaFile(candidate);
    return direct ? wsrv(direct) : "";
  }
  if (looksLikeImage(candidate)) return wsrv(candidate);
  if (/wikipedia\.org\/wiki\//i.test(candidate)){
    const img = await fromWikipediaPage(candidate);
    return img ? wsrv(img) : "";
  }
  return "";
}

/* Placeholder */
function placeholderFor(textA, textB){
  const letter = (textB || textA || "?").trim().charAt(0).toUpperCase() || "?";
  const bg = "#1b2330", fg = "#a7b9da";
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='1000' height='1000'>
      <rect width='100%' height='100%' fill='${bg}'/>
      <circle cx='500' cy='500' r='380' fill='#121a26'/>
      <text x='50%' y='56%' text-anchor='middle' font-family='Inter,Arial' font-size='420' font-weight='800' fill='${fg}'>${letter}</text>
    </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/* -------- Load & normalize -------- */
async function loadFromSheet(){
  const res = await fetch(SHEET_CSV, { cache: "no-store" });
  const text = await res.text();
  if (!text || text.trim().startsWith("<")){ console.error("Not CSV."); return; }

  const before = state.all.length;
  const { data } = parseCSV(text);
  const records = [];
  for (const row of data){
    const title  = pickField(row, HEADER_ALIASES.title);
    const artist = pickField(row, HEADER_ALIASES.artist);
    const notes  = pickField(row, HEADER_ALIASES.notes);
    const genre  = pickField(row, HEADER_ALIASES.genre);
    const coverRaw = pickField(row, HEADER_ALIASES.cover);
    const altRaw   = pickField(row, HEADER_ALIASES.alt);
    const upc      = pickField(row, HEADER_ALIASES.upc);
    if (!title && !artist) continue;
    records.push({ title, artist, notes, genre, coverRaw, altRaw, upc, cover:"" });
  }

  state.all = records;
  state.filtered = [...records];
  applySort(); applyFilters(); render();                 // placeholders
  await resolveCovers(records, 6); render();            // with covers

  buildGenreBar();

  const after = state.all.length;
  if (state.lastRefresh.before){
    const removed = Math.max(0, state.lastRefresh.before - after);
    toast(`Updated: ${after} albums${removed?` • removed ${removed}`:''}`);
  }
  state.lastRefresh.before = after;
}

async function resolveCovers(records, concurrency = 6){
  let i = 0;
  const workers = Array.from({length: concurrency}, async ()=> {
    while (i < records.length){
      const idx = i++;
      const r = records[idx];
      try{ r.cover = await chooseCover(r.coverRaw, r.altRaw, r.title, r.artist); }
      catch{ r.cover = ""; }
    }
  });
  await Promise.all(workers);
}

/* -------- Rendering -------- */
function createCard(rec){
  const node = els.cardTpl.content.firstElementChild.cloneNode(true);

  const titleEl  = node.querySelector('.title');
  const artistEl = node.querySelector('.artist');
  const genreEl  = node.querySelector('.genre');
  const notesEl  = node.querySelector('.notes');
  const imgEl    = node.querySelector('img.cover');
  const cTitle   = node.querySelector('.caption-title');
  const cArtist  = node.querySelector('.caption-artist');

  const title  = rec.title || "Untitled";
  const artist = rec.artist || "Unknown Artist";

  titleEl.textContent  = title;
  artistEl.textContent = artist;
  genreEl.textContent  = rec.genre ? `Genre: ${rec.genre}` : "";
  notesEl.textContent  = rec.notes || "";

  cTitle.textContent   = title;
  cArtist.textContent  = artist;

  imgEl.src = placeholderFor(title, artist);
  imgEl.alt = `${title} — ${artist}`;
  if (rec.cover){
    const real = new Image();
    real.crossOrigin = "anonymous";
    real.referrerPolicy = 'no-referrer';
    real.onload = () => { imgEl.src = rec.cover; };
    real.onerror = () => {};
    real.src = rec.cover;
  }

  node.addEventListener('click', (e)=>{
    node.classList.toggle('flipped');
    const sleeve = node.querySelector('.sleeve');
    sleeve.classList.add('pulse'); setTimeout(()=>sleeve.classList.remove('pulse'), 650);
  });
  node.addEventListener('keydown', (e)=>{
    if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); node.click(); }
  });

  return node;
}

function renderScroll(){
  els.scroller.innerHTML = '';
  state.filtered.forEach(r => els.scroller.appendChild(createCard(r)));
  centerToIndex(0);
}
function renderGrid(){
  els.grid.innerHTML = '';
  state.filtered.forEach(r => els.grid.appendChild(createCard(r)));
}
function render(){
  const isScroll = state.view === 'scroll';
  els.scrollView.classList.toggle('active', isScroll);
  els.gridView.classList.toggle('active', !isScroll);
  els.viewScrollBtn.classList.toggle('active', isScroll);
  els.viewGridBtn.classList.toggle('active', !isScroll);
  if (isScroll){ renderScroll(); toggleArrows(true); }
  else { renderGrid(); toggleArrows(false); }
}

/* -------- Search / Sort / Filters -------- */
function applySort(){
  const k = state.sortKey;
  state.filtered.sort((a,b)=> (a[k]||"").toLowerCase().localeCompare((b[k]||"").toLowerCase()));
}
function applyFilters(){
  const q = (state.filter.query||"").toLowerCase();
  state.filtered = state.all.filter(r=>{
    if (state.filter.genre && !(r.genre||"").toLowerCase().split(/[\/,&]| and /i).map(s=>s.trim()).includes(state.filter.genre.toLowerCase())) return false;
    if (state.filter.artist && (r.artist||"").toLowerCase() !== state.filter.artist.toLowerCase()) return false;
    const hay = `${r.title} ${r.artist} ${r.genre} ${r.notes}`.toLowerCase();
    return hay.includes(q);
  });
  applySort();
}
els.search.addEventListener('input', (e)=>{ state.filter.query = e.target.value.trim(); applyFilters(); render(); });
els.sort.addEventListener('change', ()=>{ state.sortKey = els.sort.value || 'title'; applySort(); render(); });
els.shuffle.addEventListener('click', ()=>{
  for (let i=state.filtered.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [state.filtered[i], state.filtered[j]]=[state.filtered[j], state.filtered[i]]; }
  render();
});

/* Genre bar */
function buildGenreBar(){
  const map = new Map();
  state.all.forEach(r=>{
    (r.genre||"").split(/[\/,&]| and /i).map(s=>s.trim()).filter(Boolean).forEach(g=> map.set(g, (map.get(g)||0)+1));
  });
  const top = [...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([g])=>g);
  els.chipBar.innerHTML = '';
  top.forEach(g=>{
    const c = document.createElement('button');
    c.className = 'chip';
    c.textContent = g;
    if (state.filter.genre && state.filter.genre.toLowerCase()===g.toLowerCase()) c.classList.add('active');
    c.addEventListener('click', ()=>{
      state.filter.genre = (state.filter.genre && state.filter.genre.toLowerCase()===g.toLowerCase()) ? null : g;
      buildGenreBar(); applyFilters(); render();
    });
    els.chipBar.appendChild(c);
  });
}

/* -------- View toggles -------- */
els.viewScrollBtn.addEventListener('click', ()=>{ state.view = 'scroll'; render(); });
els.viewGridBtn.addEventListener('click', ()=>{ state.view = 'grid'; render(); });

/* -------- Arrows: move exactly one card -------- */
function toggleArrows(show){ els.prev.style.display = els.next.style.display = show ? '' : 'none'; }

function visibleIndex(){
  const wrap = els.scroller;
  const wrapRect = wrap.getBoundingClientRect();
  const center = wrap.scrollLeft + wrap.clientWidth / 2;
  let bestIdx = 0, bestDist = Infinity;
  for (let i=0;i<wrap.children.length;i++){
    const el = wrap.children[i];
    const left = el.offsetLeft;
    const width = el.clientWidth;
    const mid = left + width/2;
    const d = Math.abs(mid - center);
    if (d < bestDist){ bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}
function centerToIndex(i){
  const wrap = els.scroller;
  const el = wrap.children[i];
  if (!el) return;
  const target = el.offsetLeft - (wrap.clientWidth - el.clientWidth)/2;
  wrap.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
}
els.prev.addEventListener('click', ()=>{ const i = visibleIndex(); centerToIndex(Math.max(0, i-1)); });
els.next.addEventListener('click', ()=>{ const i = visibleIndex(); centerToIndex(Math.min(els.scroller.children.length-1, i+1)); });

// After manual scroll, snap to nearest card when user stops
let scrollDebounce;
els.scroller.addEventListener('scroll', ()=>{
  clearTimeout(scrollDebounce);
  scrollDebounce = setTimeout(()=> centerToIndex(visibleIndex()), 110);
});

/* -------- Stats -------- */
function stats(recs){
  const total=recs.length, aMap=new Map(), gMap=new Map();
  for (const r of recs){
    if (r.artist) aMap.set(r.artist,(aMap.get(r.artist)||0)+1);
    if (r.genre) String(r.genre).split(/[\/,&]| and /i).map(s=>s.trim()).filter(Boolean)
      .forEach(g=>gMap.set(g,(gMap.get(g)||0)+1));
  }
  return {
    total, uniqArtists:aMap.size,
    topArtists:[...aMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10),
    topGenres:[...gMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12)
  };
}
function openStats(){
  const s = stats(state.filtered);
  const body = els.statsBody; body.innerHTML = '';

  const grid = document.createElement('div'); grid.className='stat-grid';
  grid.innerHTML = `
    <div class="stat-tile"><div>Total Albums</div><div class="stat-big">${s.total}</div></div>
    <div class="stat-tile"><div>Unique Artists</div><div class="stat-big">${s.uniqArtists}</div></div>
    <div class="stat-tile"><div>Total Genres</div><div class="stat-big">${s.topGenres.length}</div></div>`;
  body.appendChild(grid);

  if (s.topArtists.length){
    const h=document.createElement('h3'); h.textContent='Top Artists'; body.appendChild(h);
    const chips=document.createElement('div'); chips.className='chips';
    s.topArtists.forEach(([name])=>{
      const c=document.createElement('button'); c.className='chip'; c.textContent=name;
      c.addEventListener('click', ()=>{ els.statsModal.close(); state.filter.artist=name; applyFilters(); render(); toast(`Filtered by artist: ${name}`); });
      chips.appendChild(c);
    });
    body.appendChild(chips);
  }
  if (s.topGenres.length){
    const h=document.createElement('h3'); h.textContent='Top Genres'; body.appendChild(h);
    const chips=document.createElement('div'); chips.className='chips';
    s.topGenres.forEach(([g])=>{
      const c=document.createElement('button'); c.className='chip'; c.textContent=g;
      c.addEventListener('click', ()=>{ els.statsModal.close(); state.filter.genre=g; buildGenreBar(); applyFilters(); render(); toast(`Filtered by genre: ${g}`); });
      chips.appendChild(c);
    });
    body.appendChild(chips);
  }
  els.statsModal.showModal();
}
els.statsBtn.addEventListener('click', openStats);

/* -------- Search UX -------- */
els.openSearch.addEventListener('click', ()=>{ els.header.classList.add('search-open'); setTimeout(()=>els.search.focus(),20); });
els.closeSearch.addEventListener('click', ()=>{ els.header.classList.remove('search-open'); els.search.value=''; state.filter.query=''; applyFilters(); render(); });
window.addEventListener('keydown',(e)=>{
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  if ((isMac && e.metaKey && e.key.toLowerCase()==='k') || (!isMac && e.ctrlKey && e.key.toLowerCase()==='k')){
    e.preventDefault(); els.openSearch.click();
  }
});

/* -------- Scan -------- */
let mediaStream=null;
let barcodeDetector = ('BarcodeDetector' in window) ? new window.BarcodeDetector({ formats: ['ean_13','upc_a','upc_e','ean_8','code_128'] }) : null;

async function startCamera(){
  els.scanStatus.textContent='Scanning…';
  try{
    mediaStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment' }, audio:false });
    els.camera.srcObject = mediaStream;

    if (barcodeDetector){
      let run=true;
      const tick = async ()=>{
        if (!run) return;
        try{
          const det = await barcodeDetector.detect(els.camera);
          if (det && det[0]?.rawValue){
            const code = det[0].rawValue;
            els.formUPC.value = code;
            els.scanStatus.textContent = `Detected: ${code}`;
          }
        }catch{}
        requestAnimationFrame(tick);
      };
      tick();
      els.scanModal.addEventListener('close', ()=>{ run=false; }, {once:true});
    }else{
      els.scanStatus.textContent='Live scan not available. Use “Enter UPC manually.”';
    }
  }catch(err){
    console.error(err);
    els.scanStatus.textContent='Camera unavailable. Use “Enter UPC manually.”';
  }
}
function stopCamera(){ if (mediaStream){ mediaStream.getTracks().forEach(t=>t.stop()); mediaStream=null; } }
function openScan(){ els.scanModal.showModal(); document.body.classList.add('modal-open'); startCamera(); }
function closeScan(){ document.body.classList.remove('modal-open'); stopCamera(); }
els.scanModal.addEventListener('close', closeScan);

els.fab.addEventListener('click', ()=> els.fabMenu.showModal());
els.fabScan.addEventListener('click', ()=>{ els.fabMenu.close(); openScan(); });
els.fabEnter.addEventListener('click', ()=>{ els.fabMenu.close(); els.enterUPCModal.showModal(); setTimeout(()=>els.enterUPCInput.focus(),30); });
els.enterUPCGo.addEventListener('click', (e)=>{ if (els.enterUPCInput.value.trim()){ els.formUPC.value=els.enterUPCInput.value.trim(); els.enterUPCModal.close(); openScan(); } });

/* Save */
async function saveRecord(){
  const payload = {
    artist: els.formArtist.value.trim(),
    title:  els.formTitle.value.trim(),
    genre:  els.formGenre.value.trim(),
    notes:  els.formNotes.value.trim(),
    upc:    els.formUPC.value.trim()
  };

  els.saveBtn.disabled = true;
  const old = els.saveBtn.textContent; els.saveBtn.textContent='Saving…';

  const tempCover = await chooseCover("", "", payload.title, payload.artist);

  try{
    const body = new URLSearchParams(payload);
    const resp = await fetch(APPS_SCRIPT_URL, { method:'POST', body });
    if (resp.ok){
      await haptic([14,40], {audioFallback:true});
      toast('Saved');
      const existIdx = state.all.findIndex(r=> (r.upc||"")===payload.upc);
      const newRec = { title:payload.title, artist:payload.artist, genre:payload.genre, notes:payload.notes, upc:payload.upc, coverRaw:"", altRaw:"", cover: tempCover };
      if (existIdx>=0) state.all[existIdx] = {...state.all[existIdx], ...newRec};
      else state.all.unshift(newRec);
      applyFilters(); render();
    }else{
      toast('Saved locally, but server didn’t confirm. Check Web App URL & access.');
    }
  }catch(e){
    console.error(e);
    toast('Saved locally, but server didn’t confirm. Check Web App URL & access.');
  }finally{
    els.saveBtn.disabled=false; els.saveBtn.textContent=old;
  }
}
els.saveBtn.addEventListener('click', (e)=>{ e.preventDefault(); saveRecord(); });

/* -------- Image fallback if wsrv fails -------- */
document.addEventListener('error', function(e){
  const el = e.target;
  if (el && el.tagName === 'IMG' && el.classList.contains('cover')){
    const src = el.getAttribute('src')||"";
    if (src.includes('wsrv.nl') && src.includes('url=')){
      try{
        const u = new URL(src);
        const orig = u.searchParams.get('url');
        if (orig && el.dataset.fallbackTried !== '1'){
          el.dataset.fallbackTried = '1';
          el.crossOrigin = "anonymous";
          el.referrerPolicy = 'no-referrer';
          el.src = decodeURIComponent(orig);
        }
      }catch{}
    }
  }
}, true);

/* -------- Kickoff -------- */
function buildGenreBar(){
  const map = new Map();
  state.all.forEach(r=>{
    (r.genre||"").split(/[\/,&]| and /i).map(s=>s.trim()).filter(Boolean).forEach(g=> map.set(g,(map.get(g)||0)+1));
  });
  const top=[...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([g])=>g);
  els.chipBar.innerHTML='';
  top.forEach(g=>{
    const c=document.createElement('button'); c.className='chip'; c.textContent=g;
    if (state.filter.genre && state.filter.genre.toLowerCase()===g.toLowerCase()) c.classList.add('active');
    c.addEventListener('click', ()=>{ state.filter.genre = (state.filter.genre && state.filter.genre.toLowerCase()===g.toLowerCase())?null:g; buildGenreBar(); applyFilters(); render(); });
    els.chipBar.appendChild(c);
  });
}

els.refresh.addEventListener('click', async ()=>{ state.lastRefresh.before = state.all.length; toast('Refreshing…'); await loadFromSheet(); });

/* scroller keyboard */
els.scroller.addEventListener('keydown', (e)=>{
  if (e.key === 'ArrowRight'){ e.preventDefault(); els.next.click(); }
  if (e.key === 'ArrowLeft'){ e.preventDefault(); els.prev.click(); }
});

window.loadFromSheet = loadFromSheet;
loadFromSheet().catch(err=>{ console.error(err); alert("Couldn’t load the Google Sheet. Make sure your link is published as CSV (output=csv)."); });
