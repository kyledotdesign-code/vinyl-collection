/* -------------------------------------------
   Vinyl Collection — app.js
   Fixes cover fetching + keeps form-POST to Apps Script
--------------------------------------------*/

// 0) CONFIG
const SHEET_CSV =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?output=csv";

// Your Google Apps Script Web App URL
const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwmcZPZbg3-Cfev8OTt_YGIsrTZ3Lb_BZ2xQ5bRxh9Hpy9OvkYkOqeubtl1MQ4OGqZAJw/exec";

// 1) ELEMENTS
const $ = (s, r = document) => r.querySelector(s);

const els = {
  search: $('#search'),
  viewScrollBtn: $('#view-scroll'),
  viewGridBtn: $('#view-grid'),
  sort: $('#sort'),
  shuffle: $('#shuffle'),
  statsBtn: $('#statsBtn'),
  scroller: $('#scroller'),
  grid: $('#grid'),
  prev: $('#scrollPrev'),
  next: $('#scrollNext'),
  statsModal: $('#statsModal'),
  statsBody: $('#statsBody'),
  cardTpl: $('#cardTpl'),
  scrollView: $('#scrollView'),
  gridView: $('#gridView'),
  // Scan
  scanBtn: $('#scanBtn'),
  scanModal: $('#scanModal'),
  scanVideo: $('#scanVideo'),
  scanCanvas: $('#scanCanvas'),
  scanHint: $('#scanHint'),
  manualUPC: $('#manualUPC'),
  closeScan: $('#closeScan'),
  scanStatus: $('#scanStatus'),
};

// 2) STATE
const state = {
  all: [],
  filtered: [],
  sortKey: 'title',
  view: 'scroll',
  mediaStream: null,
  scanning: false,
  rafId: null,
  detectorSupported: 'BarcodeDetector' in window,
  detector: null,
};

// 3) CSV PARSER
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

// 4) HEADER PICKING
const HEADER_ALIASES = {
  title:  ["title","album","record","release"],
  artist: ["artist","artists","band"],
  genre:  ["genre","genres","style","category"],
  notes:  ["notes","special notes","comment","comments","description"],
  cover:  ["album artwork","artwork","cover","cover url","image","art","art url","artwork url"],
  alt:    ["alt artwork","alt image","alt cover","alt art"],
  upc:    ["upc","barcode","ean"],
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

// 5) ARTWORK HELPERS
function wsrv(url){
  return `https://wsrv.nl/?url=${encodeURIComponent(url)}&w=1000&h=1000&fit=cover&output=webp&q=85`;
}

// Wikipedia page → lead image URL
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

// Treat ANY http(s) candidate as an image (proxy through wsrv),
// but still special-case Wikipedia page URLs.
async function chooseCover(coverRaw, altRaw){
  const candidate = coverRaw || altRaw || "";
  if (!candidate) return "";

  // Wikipedia page (HTML) → resolve to image first
  if (/wikipedia\.org\/wiki\//i.test(candidate)){
    const img = await fromWikipediaPage(candidate);
    return img ? wsrv(img) : "";
  }

  // If it's any http(s) URL (e.g., Cover Art Archive /front w/o extension), try it via proxy.
  if (/^https?:\/\//i.test(candidate)){
    return wsrv(candidate);
  }

  // Otherwise nothing we can do
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

// 6) LOAD & NORMALIZE
async function loadFromSheet(){
  const res = await fetch(SHEET_CSV, { cache: "no-store" });
  const text = await res.text();
  if (!text || text.trim().startsWith("<")){
    console.error("Not a CSV export. Ensure ?output=csv.");
    return;
  }

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
  applySort();
  render();
  await resolveCovers(records, 6);
  render();
}
async function resolveCovers(records, concurrency = 6){
  let i = 0;
  const workers = Array.from({length: concurrency}, async ()=> {
    while (i < records.length){
      const idx = i++;
      const r = records[idx];
      try{ r.cover = await chooseCover(r.coverRaw, r.altRaw); }
      catch{ r.cover = ""; }
    }
  });
  await Promise.all(workers);
}

// 7) RENDERING
function createCard(rec){
  const tpl = els.cardTpl?.content?.firstElementChild;
  const node = tpl ? tpl.cloneNode(true) : document.createElement('article');

  if (!tpl){
    node.className = 'card';
    node.innerHTML = `
      <div class="sleeve">
        <div class="face front"><img class="cover" alt=""></div>
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

  const title  = rec.title || "Untitled";
  const artist = rec.artist || "Unknown Artist";

  titleEl.textContent  = title;
  artistEl.textContent = artist;
  genreEl.textContent  = rec.genre ? `Genre: ${rec.genre}` : "";
  notesEl.textContent  = rec.notes || "";
  cTitle.textContent   = title;
  cArtist.textContent  = artist;

  // placeholder, then swap
  imgEl.src = placeholderFor(title, artist);
  imgEl.alt = `${title} — ${artist}`;

  if (rec.cover){
    const real = new Image();
    real.referrerPolicy = 'no-referrer';
    real.onload = () => { imgEl.src = rec.cover; };
    real.onerror = () => {}; // keep placeholder on fail
    real.src = rec.cover;
  }

  node.addEventListener('click', ()=> node.classList.toggle('flipped'));
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

// 8) SEARCH / SORT / SHUFFLE
function applySort(){
  const k = state.sortKey;
  state.filtered.sort((a,b)=>{
    const A = (a[k]||"").toLowerCase();
    const B = (b[k]||"").toLowerCase();
    return A.localeCompare(B);
  });
}
els.search.addEventListener('input', (e)=>{
  const q = e.target.value.trim().toLowerCase();
  state.filtered = state.all.filter(r=>{
    const hay = `${r.title} ${r.artist} ${r.genre} ${r.notes}`.toLowerCase();
    return hay.includes(q);
  });
  applySort(); render();
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

// 9) VIEW TOGGLES
els.viewScrollBtn.addEventListener('click', ()=>{ state.view = 'scroll'; render(); });
els.viewGridBtn.addEventListener('click', ()=>{ state.view = 'grid'; render(); });

// 10) ARROWS
function toggleArrows(show){
  els.prev.style.display = show ? '' : 'none';
  els.next.style.display = show ? '' : 'none';
}
function scrollByAmount(px){
  els.scroller.scrollBy({ left: px, behavior: 'smooth' });
}
els.prev.addEventListener('click', ()=> scrollByAmount(-Math.round(els.scroller.clientWidth*0.9)));
els.next.addEventListener('click', ()=> scrollByAmount(Math.round(els.scroller.clientWidth*0.9)));

// 11) STATS
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
    s.topArtists.forEach(([name,n])=>{
      const c = document.createElement('span'); c.className='chip'; c.textContent = `${name} • ${n}`;
      chips.appendChild(c);
    });
    body.appendChild(chips);
  }

  if (s.topGenres.length){
    const h = document.createElement('h3'); h.textContent = 'Top Genres'; body.appendChild(h);
    const chips = document.createElement('div'); chips.className = 'chips';
    s.topGenres.forEach(([g,n])=>{
      const c = document.createElement('span'); c.className='chip'; c.textContent = `${g} • ${n}`;
      chips.appendChild(c);
    });
    body.appendChild(chips);
  }

  els.statsModal.showModal();
}
els.statsBtn.addEventListener('click', openStats);

// 12) UPC LOOKUP (MusicBrainz + Cover Art Archive)
async function lookupByUPC(upc){
  const url = `https://musicbrainz.org/ws/2/release/?query=barcode:${encodeURIComponent(upc)}&fmt=json`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' }});
  if(!r.ok) throw new Error('MusicBrainz request failed');
  const j = await r.json();
  const releases = j?.releases || [];
  if (!releases.length) throw new Error('No releases found for that UPC');

  releases.sort((a,b)=>{
    const ac = (a['cover-art-archive']?.front?1:0) - (b['cover-art-archive']?.front?1:0);
    if (ac !== 0) return -ac;
    return (b.score||0) - (a.score||0);
  });
  const rel = releases[0];

  const mbid = rel.id;
  const title = rel.title || '';
  const artist = (rel['artist-credit']||[])
    .map(c=>c?.name || c?.artist?.name)
    .filter(Boolean)
    .join(', ') || (rel['artist-credit-phrase'] || '');

  let coverUrl = "";
  try{
    const artJson = await fetch(`https://coverartarchive.org/release/${mbid}`, {
      headers: { 'Accept': 'application/json' }
    });
    if (artJson.ok){
      const art = await artJson.json();
      const front = (art.images||[]).find(img=>img.front) || art.images?.[0];
      coverUrl = front?.image || "";
    } else {
      // Even if this returns a 302 to an image without extension, our wsrv proxy will handle it.
      coverUrl = `https://coverartarchive.org/release/${mbid}/front`;
    }
  }catch{ /* ignore */ }

  return {
    title, artist, upc,
    coverRaw: coverUrl || "",
    altRaw: "",
    notes: "",
    genre: "",
  };
}

// 13) ADD TO GOOGLE SHEET (Apps Script) — form-encoded (no preflight)
async function addRecordToSheet(rec){
  const form = new URLSearchParams({
    title: rec.title || "",
    artist: rec.artist || "",
    upc: rec.upc || "",
    genre: rec.genre || "",
    notes: rec.notes || "",
    cover: rec.coverRaw || "",
    alt: rec.altRaw || "",
  });

  try {
    const resp = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: form.toString(),
    });

    // Try to read JSON; if not possible (opaque), we still treat it as sent
    let json = {};
    try { json = await resp.clone().json(); } catch {}
    if (!resp.ok && resp.type !== 'opaque') {
      throw new Error(`Apps Script error (${resp.status})`);
    }
    return json;
  } catch (e) {
    // Strict CORS fallback: fire-and-forget
    try {
      await fetch(APPS_SCRIPT_URL, { method: 'POST', mode: 'no-cors', body: form });
      return { opaque: true };
    } catch (e2) {
      throw e;
    }
  }
}

// 14) OPTIMISTIC ADD + REFRESH
async function addToCollection(rec){
  rec.cover = await chooseCover(rec.coverRaw, rec.altRaw);

  // Optimistic UI
  state.all.unshift(rec);
  state.filtered = [...state.all];
  applySort();
  render();

  try{
    const res = await addRecordToSheet(rec);
    // Optional: re-sync from sheet if you want absolute source of truth
    // await loadFromSheet();

    // Show a tiny confirmation in console for debugging
    console.log('Apps Script response:', res);
  }catch(e){
    console.error(e);
    alert("Saved locally, but failed to add to sheet:\n" + e.message);
  }
}

// 15) SCANNER (auto-start when opening modal)
async function startCamera(){
  const constraints = {
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  };
  state.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
  els.scanVideo.srcObject = state.mediaStream;
  await els.scanVideo.play();
}
function stopCamera(){
  if (state.mediaStream){
    for (const t of state.mediaStream.getTracks()){ t.stop(); }
    state.mediaStream = null;
  }
  els.scanVideo.pause();
  els.scanVideo.srcObject = null;
}
async function scanLoop(){
  if (!state.scanning) return;
  try{
    if (state.detector){
      const codes = await state.detector.detect(els.scanVideo);
      if (codes && codes.length){
        const upcRaw = (codes[0].rawValue || "").trim();
        if (upcRaw){
          await handleUPC(upcRaw);
          return;
        }
      }
    }
  }catch(err){ console.error('scanLoop error', err); }
  state.rafId = requestAnimationFrame(scanLoop);
}
async function handleUPC(upc){
  state.scanning = false;
  if (state.rafId) cancelAnimationFrame(state.rafId);
  stopCamera();
  els.scanStatus.textContent = `Found UPC: ${upc}. Looking up…`;

  try{
    const rec = await lookupByUPC(upc);
    els.scanStatus.textContent = `Found: ${rec.artist} — ${rec.title}. Adding…`;
    await addToCollection(rec);
    els.scanStatus.textContent = `Added to your collection (sent to Sheet).`;
    setTimeout(()=> els.scanModal.close(), 600);
  }catch(e){
    console.error(e);
    els.scanStatus.textContent = `Couldn’t find that UPC automatically. You can enter details manually.`;
  }
}
async function openScanModal(){
  els.scanStatus.textContent = '';
  els.scanModal.showModal();

  try{
    if (state.detectorSupported && !state.detector){
      try{
        state.detector = new window.BarcodeDetector({
          formats: ['ean_13','ean_8','upc_a','upc_e','code_128','code_39']
        });
      }catch{
        state.detector = new window.BarcodeDetector();
      }
    }
    await startCamera();
    state.scanning = !!state.detectorSupported;
    els.scanHint.textContent = state.detectorSupported
      ? 'Point your camera at the barcode.'
      : 'Camera started, but live scan not supported. Use “Enter UPC manually.”';

    if (state.scanning) scanLoop();
  }catch(e){
    console.error(e);
    els.scanStatus.textContent = 'Camera unavailable. Use “Enter UPC manually.”';
  }
}
function closeScanModal(){
  state.scanning = false;
  if (state.rafId) cancelAnimationFrame(state.rafId);
  stopCamera();
  els.scanModal.close();
}

// Events
els.scanBtn.addEventListener('click', openScanModal);
els.closeScan?.addEventListener('click', closeScanModal);
els.manualUPC.addEventListener('click', async ()=>{
  const upc = prompt("Enter UPC (numbers only):") || "";
  const trimmed = upc.replace(/\D+/g,'').trim();
  if (!trimmed){
    els.scanStatus.textContent = 'No UPC entered.';
    return;
  }
  await handleUPC(trimmed);
});

// 16) KICKOFF
loadFromSheet().catch(err=>{
  console.error(err);
  alert("Couldn’t load the Google Sheet. Make sure your link is published as CSV (output=csv).");
});
