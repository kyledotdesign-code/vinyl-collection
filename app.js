/* =========================================
   Vinyl Collection — app.js (polish pack)
   ========================================= */

/* ---------- CONFIG ---------- */
const SHEET_CSV =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?output=csv";

const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwmcZPZbg3-Cfev8OTt_YGIsrTZ3Lb_BZ2xQ5bRxh9Hpy9OvkYkOqeubtl1MQ4OGqZAJw/exec";

// Optional Discogs: set in localStorage.discogsToken manually or add a small settings UI later.
const DISCOGS_TOKEN = localStorage.getItem("discogsToken") || "";

/* ---------- ELEMENTS ---------- */
const $ = (s, r = document) => r.querySelector(s);

const els = {
  // header/search
  header: $('.site-header'),
  openSearch: $('#openSearch'),
  closeSearch: $('#closeSearch'),
  search: $('#search'),

  viewScrollBtn: $('#view-scroll'),
  viewGridBtn: $('#view-grid'),
  sort: $('#sort'),
  shuffle: $('#shuffle'),
  refresh: $('#refresh'),
  missingBtn: $('#missingBtn'),
  exportBtn: $('#exportBtn'),

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

/* ---------- STATE ---------- */
const state = {
  all: [],
  filtered: [],
  sortKey: 'title', // 'title' | 'artist'
  view: 'scroll',   // 'scroll' | 'grid'
  filter: {
    query: '',
    genre: null,
    artist: null,
    missingOnly: false,
  },
  lastRefresh: { before: 0, after: 0, removed: 0, updated: 0 },
};
window.state = state; // for debug

/* ---------- UTILS ---------- */
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
  setTimeout(() => t.remove(), 5000);
}

function vibrate(pattern){ try{ navigator.vibrate && navigator.vibrate(pattern); }catch{} }

function csvEscape(s){ return /[",\n]/.test(s) ? `"${String(s).replace(/"/g,'""')}"` : String(s); }

function downloadFile(name, text, type="text/plain"){
  const blob = new Blob([text], {type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
}

/* ---------- CSV PARSER ---------- */
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
      rows.push(cur);
      cur = [''];
      if (c === '\r' && text[i+1] === '\n') i++;
    } else {
      cur[cur.length-1] += c;
    }
  }
  if (cur.length > 1 || cur[0] !== '') rows.push(cur);
  if (rows.length === 0) return { header: [], data: [] };
  const header = rows[0].map(h => h.trim());
  const data = rows.slice(1).map(r => {
    const o = {};
    header.forEach((h, idx)=> o[h] = (r[idx] ?? '').trim());
    return o;
  });
  return { header, data };
}

/* ---------- HEADER PICKING ---------- */
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

/* ---------- ARTWORK HELPERS ---------- */
function looksLikeImage(u){ return /\.(png|jpe?g|webp|gif|avif)(\?|#|$)/i.test(u||""); }
function wsrv(url){
  return `https://wsrv.nl/?url=${encodeURIComponent(url)}&w=1000&h=1000&fit=cover&output=webp&q=85`;
}

// Wikipedia article page → lead image URL
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

// Wikipedia File: page → direct image via Special:FilePath
function fromWikipediaFile(fileUrl){
  const m = fileUrl.match(/wikipedia\.org\/wiki\/File:(.+)$/i);
  if(!m) return "";
  const filename = decodeURIComponent(m[1]);
  return `https://en.wikipedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}`;
}

// Search Wikipedia by text (Title + Artist)
async function wikipediaSearchImage(q){
  try{
    const src = `https://en.wikipedia.org/w/api.php?action=query&origin=*&list=search&srsearch=${encodeURIComponent(q)}&utf8=&format=json&srlimit=1`;
    const r = await fetch(src);
    if(!r.ok) return "";
    const j = await r.json();
    const page = j?.query?.search?.[0];
    if(!page) return "";
    const title = page.title;
    return await fromWikipediaPage(`https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`);
  }catch{ return ""; }
}

// Decide cover for a row
async function chooseCover(coverRaw, altRaw, title="", artist=""){
  const candidate = coverRaw || altRaw || "";
  if (!candidate){
    // Try a Wikipedia search fallback
    const img = await wikipediaSearchImage(`${title} ${artist} album cover`);
    return img ? wsrv(img) : "";
  }

  if (/wikipedia\.org\/wiki\/File:/i.test(candidate)){
    const direct = fromWikipediaFile(candidate);
    return direct ? wsrv(direct) : "";
  }
  if (looksLikeImage(candidate)){ return wsrv(candidate); }
  if (/wikipedia\.org\/wiki\//i.test(candidate)){
    const img = await fromWikipediaPage(candidate);
    return img ? wsrv(img) : "";
  }
  return "";
}

// Placeholder SVG
function placeholderFor(textA, textB){
  const letter = (textB || textA || "?").trim().charAt(0).toUpperCase() || "?";
  const bg = "#1b2330";
  const fg = "#a7b9da";
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='1000' height='1000'>
      <rect width='100%' height='100%' fill='${bg}'/>
      <circle cx='500' cy='500' r='380' fill='#121a26'/>
      <text x='50%' y='56%' text-anchor='middle' font-family='Inter,Arial' font-size='420' font-weight='800' fill='${fg}'>${letter}</text>
    </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/* ---------- LOAD & NORMALIZE ---------- */
async function loadFromSheet(){
  const res = await fetch(SHEET_CSV, { cache: "no-store" });
  const text = await res.text();
  if (!text || text.trim().startsWith("<")){
    console.error("Not a CSV export. Ensure ?output=csv.");
    return;
  }

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

  // Render fast with placeholders first
  state.all = records;
  state.filtered = [...records];
  applySort();
  applyFilters();
  render();            // placeholders only
  await resolveCovers(records, 6);
  render();            // swap to real covers

  // Build genre bar from current data
  buildGenreBar();

  // Refresh summary toast
  const after = state.all.length;
  const removed = Math.max(0, state.lastRefresh.before - after);
  if (state.lastRefresh.before){
    toast(`Updated: ${after} albums • removed ${removed}${removed ? ' (no longer in Sheet)' : ''}`);
  }
  state.lastRefresh.before = after;
}

async function resolveCovers(records, concurrency = 6){
  let i = 0;
  const workers = Array.from({length: concurrency}, async ()=> {
    while (i < records.length){
      const idx = i++;
      const r = records[idx];
      try{
        r.cover = await chooseCover(r.coverRaw, r.altRaw, r.title, r.artist);
      }catch{ r.cover = ""; }
    }
  });
  await Promise.all(workers);
}

/* ---------- RENDERING ---------- */
function createCard(rec){
  const tpl = els.cardTpl?.content?.firstElementChild;
  const node = tpl ? tpl.cloneNode(true) : document.createElement('article');

  if (!tpl){
    node.className = 'card';
    node.innerHTML = `
      <div class="sleeve">
        <div class="face front"><img class="cover" alt=""><button class="share-btn">⤴</button></div>
        <div class="face back">
          <div class="meta">
            <h3 class="title"></h3>
            <p class="artist"></p>
            <p class="genre"></p>
            <p class="notes"></p>
          </div>
        </div>
      </div>
      <div class="caption">
        <div class="caption-title"></div>
        <div class="caption-artist"></div>
      </div>`;
  }

  const titleEl  = node.querySelector('.title');
  const artistEl = node.querySelector('.artist');
  const genreEl  = node.querySelector('.genre');
  const notesEl  = node.querySelector('.notes');
  const imgEl    = node.querySelector('img.cover');
  const cTitle   = node.querySelector('.caption-title');
  const cArtist  = node.querySelector('.caption-artist');
  const shareBtn = node.querySelector('.share-btn');

  const title  = rec.title || "Untitled";
  const artist = rec.artist || "Unknown Artist";

  titleEl.textContent  = title;
  artistEl.textContent = artist;
  genreEl.textContent  = rec.genre ? `Genre: ${rec.genre}` : "";
  notesEl.textContent  = rec.notes || "";

  cTitle.textContent   = title;
  cArtist.textContent  = artist;

  // placeholder
  const ph = placeholderFor(title, artist);
  imgEl.src = ph;
  imgEl.alt = `${title} — ${artist}`;

  // swap to cover if available
  if (rec.cover){
    const real = new Image();
    real.crossOrigin = "anonymous";
    real.referrerPolicy = 'no-referrer';
    real.onload = () => { imgEl.src = rec.cover; };
    real.onerror = () => {}; // keep placeholder
    real.src = rec.cover;
  }

  // Flip on click/Enter/Space
  node.addEventListener('click', (e)=>{
    if (e.target === shareBtn) return;
    node.classList.toggle('flipped');
    const sleeve = node.querySelector('.sleeve');
    sleeve.classList.add('pulse');
    setTimeout(()=>sleeve.classList.remove('pulse'), 650);
  });
  node.addEventListener('keydown', (e)=>{
    if (e.key === 'Enter' || e.key === ' '){
      e.preventDefault();
      node.click();
    }
  });

  // Share
  shareBtn.addEventListener('click', async (e)=>{
    e.stopPropagation();
    const url = rec.cover || rec.coverRaw || rec.altRaw || '';
    const text = `${rec.title} — ${rec.artist}`;
    try{
      if (navigator.share){
        await navigator.share({ title: rec.title, text, url });
      }else{
        await navigator.clipboard.writeText(url || text);
        toast('Link copied to clipboard');
      }
    }catch{}
  });

  return node;
}

function renderScroll(){
  els.scroller.innerHTML = '';
  state.filtered.forEach(r => els.scroller.appendChild(createCard(r)));
  els.scroller.scrollLeft = 0;
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

/* ---------- SEARCH / SORT / FILTER ---------- */
function applySort(){
  const k = state.sortKey;
  state.filtered.sort((a,b)=>{
    const A = (a[k]||"").toLowerCase();
    const B = (b[k]||"").toLowerCase();
    return A.localeCompare(B);
  });
}

function applyFilters(){
  const q = (state.filter.query||"").toLowerCase();
  state.filtered = state.all.filter(r=>{
    if (state.filter.genre && !(r.genre||"").toLowerCase().split(/[\/,&]| and /i).map(s=>s.trim()).includes(state.filter.genre.toLowerCase())) return false;
    if (state.filter.artist && (r.artist||"").toLowerCase() !== state.filter.artist.toLowerCase()) return false;
    if (state.filter.missingOnly && r.cover) return false;
    const hay = `${r.title} ${r.artist} ${r.genre} ${r.notes}`.toLowerCase();
    return hay.includes(q);
  });
  applySort();
}

els.search.addEventListener('input', (e)=>{
  state.filter.query = e.target.value.trim();
  applyFilters(); render();
});

els.sort.addEventListener('change', ()=>{
  state.sortKey = els.sort.value || 'title';
  applySort(); render();
});

els.shuffle.addEventListener('click', ()=>{
  for (let i = state.filtered.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [state.filtered[i], state.filtered[j]] = [state.filtered[j], state.filtered[i]];
  }
  render();
});

els.missingBtn.addEventListener('click', ()=>{
  state.filter.missingOnly = !state.filter.missingOnly;
  els.missingBtn.classList.toggle('active', state.filter.missingOnly);
  applyFilters(); render();
});

/* genre chip bar */
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
      buildGenreBar();
      applyFilters(); render();
    });
    els.chipBar.appendChild(c);
  });
}

/* ---------- VIEW TOGGLES ---------- */
els.viewScrollBtn.addEventListener('click', ()=>{ state.view = 'scroll'; render(); });
els.viewGridBtn.addEventListener('click', ()=>{ state.view = 'grid'; render(); });

/* ---------- ARROWS ---------- */
function toggleArrows(show){
  els.prev.style.display = show ? '' : 'none';
  els.next.style.display = show ? '' : 'none';
}
function scrollByAmount(px){
  els.scroller.scrollBy({ left: px, behavior: 'smooth' });
}
els.prev.addEventListener('click', ()=> scrollByAmount(-Math.round(els.scroller.clientWidth*0.9)));
els.next.addEventListener('click', ()=> scrollByAmount(Math.round(els.scroller.clientWidth*0.9)));

/* ---------- STATS ---------- */
function buildStats(recs){
  const total = recs.length;
  const artistMap = new Map();
  const genreMap  = new Map();
  for (const r of recs){
    if (r.artist) artistMap.set(r.artist, (artistMap.get(r.artist)||0)+1);
    if (r.genre){
      String(r.genre).split(/[\/,&]| and /i).map(s=>s.trim()).filter(Boolean)
        .forEach(g => genreMap.set(g, (genreMap.get(g)||0)+1));
    }
  }
  const topArtists = [...artistMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10);
  const topGenres  = [...genreMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12);
  return { total, uniqArtists: artistMap.size, topArtists, topGenres };
}
function openStats(){
  const s = buildStats(state.filtered);
  const body = els.statsBody; body.innerHTML = '';

  const grid = document.createElement('div'); grid.className = 'stat-grid';
  const totalGenres = s.topGenres.length;
  grid.innerHTML = `
    <div class="stat-tile"><div>Total Albums</div><div class="stat-big">${s.total}</div></div>
    <div class="stat-tile"><div>Unique Artists</div><div class="stat-big">${s.uniqArtists}</div></div>
    <div class="stat-tile"><div>Total Genres</div><div class="stat-big">${totalGenres}</div></div>
  `;
  body.appendChild(grid);

  if (s.topArtists.length){
    const h = document.createElement('h3'); h.textContent = 'Top Artists'; body.appendChild(h);
    const chips = document.createElement('div'); chips.className = 'chips';
    s.topArtists.forEach(([name])=>{
      const c = document.createElement('button'); c.className='chip'; c.textContent = name;
      c.addEventListener('click', ()=>{ els.statsModal.close(); state.filter.artist = name; applyFilters(); render(); toast(`Filtered by artist: ${name}`); });
      chips.appendChild(c);
    });
    body.appendChild(chips);
  }

  if (s.topGenres.length){
    const h = document.createElement('h3'); h.textContent = 'Top Genres'; body.appendChild(h);
    const chips = document.createElement('div'); chips.className = 'chips';
    s.topGenres.forEach(([g])=>{
      const c = document.createElement('button'); c.className='chip'; c.textContent = g;
      c.addEventListener('click', ()=>{ els.statsModal.close(); state.filter.genre = g; buildGenreBar(); applyFilters(); render(); toast(`Filtered by genre: ${g}`); });
      chips.appendChild(c);
    });
    body.appendChild(chips);
  }

  els.statsModal.showModal();
}
els.statsBtn.addEventListener('click', openStats);

/* ---------- EXPORT CSV (current view) ---------- */
els.exportBtn.addEventListener('click', ()=>{
  const head = ['Artist','Title','Genre','Special Notes','Album Artwork','Alt Artwork','UPC'];
  const rows = state.filtered.map(r=>[
    r.artist||'', r.title||'', r.genre||'', r.notes||'', r.coverRaw||'', r.altRaw||'', r.upc||''
  ].map(csvEscape).join(','));
  const text = [head.join(','), ...rows].join('\n');
  downloadFile('vinyl-export.csv', text, 'text/csv');
});

/* ---------- SEARCH UX ---------- */
els.openSearch.addEventListener('click', ()=>{
  els.header.classList.add('search-open');
  setTimeout(()=> els.search.focus(), 20);
});
els.closeSearch.addEventListener('click', ()=> {
  els.header.classList.remove('search-open');
  els.search.value = '';
  state.filter.query = '';
  applyFilters(); render();
});

// Cmd/Ctrl+K
window.addEventListener('keydown',(e)=>{
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  if ((isMac && e.metaKey && e.key.toLowerCase()==='k') || (!isMac && e.ctrlKey && e.key.toLowerCase()==='k')){
    e.preventDefault(); els.openSearch.click();
  }
});

/* ---------- SCAN FLOW ---------- */
let mediaStream = null;
let barcodeDetector = ('BarcodeDetector' in window) ? new window.BarcodeDetector({ formats: ['ean_13','upc_a','upc_e','ean_8','code_128'] }) : null;

async function startCamera(){
  els.scanStatus.textContent = 'Scanning…';
  try{
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio:false });
    els.camera.srcObject = mediaStream;

    if (barcodeDetector){
      const track = mediaStream.getVideoTracks()[0];
      const img = document.createElement('video');
      img.srcObject = new MediaStream([track]);
      img.play();

      let scanning = true;
      const tick = async ()=>{
        if (!scanning) return;
        try{
          const det = await barcodeDetector.detect(els.camera);
          if (det && det[0] && det[0].rawValue){
            const code = det[0].rawValue;
            vibrate(12);
            els.formUPC.value = code;
            els.scanStatus.textContent = `Detected: ${code}`;
            // If we already have this UPC, highlight existing
            highlightByUPC(code);
          }
        }catch{}
        requestAnimationFrame(tick);
      };
      tick();

      // Stop when modal closes
      els.scanModal.addEventListener('close', ()=>{ scanning = false; }, { once:true });
    } else {
      els.scanStatus.textContent = 'Live scan not available. Use “Enter UPC manually.”';
    }
  }catch(err){
    console.error(err);
    els.scanStatus.textContent = 'Camera unavailable. Use “Enter UPC manually.”';
  }
}

function stopCamera(){
  if (mediaStream){
    mediaStream.getTracks().forEach(t=>t.stop());
    mediaStream = null;
  }
}

function openScan(){
  els.scanModal.showModal();
  document.body.classList.add('modal-open');
  // start camera immediately
  startCamera();
}
function closeScan(){
  document.body.classList.remove('modal-open');
  stopCamera();
}

els.scanModal.addEventListener('close', closeScan);

// FAB
els.fab.addEventListener('click', ()=> els.fabMenu.showModal());
els.fabScan.addEventListener('click', ()=>{ els.fabMenu.close(); openScan(); });
els.fabEnter.addEventListener('click', ()=>{
  els.fabMenu.close(); els.enterUPCModal.showModal();
  setTimeout(()=> els.enterUPCInput.focus(), 30);
});
els.enterUPCGo.addEventListener('click', (e)=>{
  if (els.enterUPCInput.value.trim()){
    els.formUPC.value = els.enterUPCInput.value.trim();
    els.enterUPCModal.close(); openScan();
  }
});

/* ---------- SAVE TO SHEET ---------- */
async function saveRecord(){
  const payload = {
    artist: els.formArtist.value.trim(),
    title:  els.formTitle.value.trim(),
    genre:  els.formGenre.value.trim(),
    notes:  els.formNotes.value.trim(),
    upc:    els.formUPC.value.trim()
  };

  // Basic de-dupe (client): if UPC already in collection, highlight it
  if (payload.upc && state.all.some(r=> (r.upc||"")===payload.upc )){
    highlightByUPC(payload.upc);
    toast('UPC already exists — updated notes instead if needed.');
  }

  els.saveBtn.disabled = true;
  const oldText = els.saveBtn.textContent;
  els.saveBtn.textContent = 'Saving…';

  // Try to enrich via Discogs by barcode if token present and fields missing
  if (DISCOGS_TOKEN && payload.upc && (!payload.title || !payload.artist)){
    try{
      const r = await fetch(`https://api.discogs.com/database/search?barcode=${encodeURIComponent(payload.upc)}&token=${encodeURIComponent(DISCOGS_TOKEN)}`);
      const j = await r.json();
      const first = j?.results?.[0];
      if (first){
        // title comes like "Artist - Title"
        const t = first.title||"";
        const dash = t.indexOf(' - ');
        if (!payload.artist && dash>0) payload.artist = t.slice(0,dash);
        if (!payload.title && dash>0) payload.title  = t.slice(dash+3);
        if (!payload.title && !payload.artist) payload.title = t;
        // cover hint
        if (!payload.cover && first.cover_image) payload.cover = first.cover_image;
      }
    }catch{}
  }

  // Add cover attempt in client (for immediate view)
  const tempCover = await chooseCover(payload.cover||"", "", payload.title, payload.artist);

  try{
    // Form-encoded to avoid preflight
    const body = new URLSearchParams(payload);
    const resp = await fetch(APPS_SCRIPT_URL, { method:'POST', body });
    const ok = resp.ok;
    if (ok){
      vibrate([14,40]);
      toast('Saved');
      // Optimistically add/update in local state; on next Update we’ll reconcile with Sheet
      const existingIdx = state.all.findIndex(r=> (r.upc||"")===payload.upc);
      const newRec = {
        title: payload.title, artist: payload.artist, genre: payload.genre, notes: payload.notes,
        upc: payload.upc, coverRaw: payload.cover||"", altRaw:"", cover: tempCover
      };
      if (existingIdx >= 0) state.all[existingIdx] = {...state.all[existingIdx], ...newRec};
      else state.all.unshift(newRec);
      applyFilters(); render();
    }else{
      toast('Saved locally, but server didn’t confirm. Check Web App URL & access.');
    }
  }catch(err){
    console.error(err);
    toast('Saved locally, but server didn’t confirm. Check Web App URL & access.');
  }finally{
    els.saveBtn.disabled = false;
    els.saveBtn.textContent = oldText;
  }
}

els.saveBtn.addEventListener('click', (e)=>{ e.preventDefault(); saveRecord(); });

/* ---------- HELPERS: highlight existing UPC ---------- */
function highlightByUPC(upc){
  const idx = state.all.findIndex(r=> (r.upc||"")===String(upc));
  if (idx===-1) return;
  const isScroll = state.view==='scroll';
  const parent = isScroll ? els.scroller : els.grid;
  const card = parent.children[idx];
  if (card){
    card.scrollIntoView({ behavior:'smooth', inline:'center', block:'nearest' });
    card.classList.add('pulse');
    setTimeout(()=> card.classList.remove('pulse'), 1200);
  }
}

/* ---------- UPDATE COLLECTION (force reload) ---------- */
els.refresh.addEventListener('click', async ()=>{
  state.lastRefresh.before = state.all.length;
  toast('Refreshing…');
  await loadFromSheet();
  // validator: show quick issues
  const issues = [];
  state.all.forEach((r,i)=>{
    if (!r.title || !r.artist) issues.push(`Row ${i+2}: missing title/artist`);
    if (!r.cover && !(r.coverRaw||r.altRaw)) issues.push(`Row ${i+2}: no artwork link`);
  });
  if (issues.length){
    toast(`${issues.length} potential issues`, [
      { label: 'View', onClick: ()=> alert(issues.slice(0,40).join('\n')) }
    ]);
  }
});

/* ---------- EXPORT: already wired ---------- */

/* ---------- KEYBOARD NAV FOR SCROLLER ---------- */
els.scroller.addEventListener('keydown', (e)=>{
  if (e.key === 'ArrowRight') { e.preventDefault(); els.next.click(); }
  if (e.key === 'ArrowLeft')  { e.preventDefault(); els.prev.click(); }
});

/* ---------- IMAGE FALLBACK: if wsrv fails, load original once ---------- */
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

/* ---------- KICKOFF ---------- */
window.loadFromSheet = loadFromSheet; // exposed for debug
loadFromSheet().catch(err=>{
  console.error(err);
  alert("Couldn’t load the Google Sheet. Make sure your link is published as CSV (output=csv).");
});
