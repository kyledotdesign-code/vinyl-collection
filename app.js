/* -------------------------------------------
   Vinyl Collection — app.js (Papa-free)
   Sheet CSV: publish-to-web (output=csv)
--------------------------------------------*/

// 0) CONFIG
const SHEET_CSV =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?output=csv";

// optional Apps Script endpoint you shared (not required for this file to work)
const GAS_URL =
  "https://script.google.com/macros/s/AKfycbwpf5emXEyiy-vTaq7bnZzOzC7TxFSy53XqO9mId1wTSze0m-KLxyrbnWRT0xohwK4TRg/exec";

// 1) ELEMENTS (strict to the IDs in your index.html)
const $ = (s, r = document) => r.querySelector(s);

const els = {
  search: $('#search'),
  viewScrollBtn: $('#view-scroll'),
  viewGridBtn: $('#view-grid'),
  sort: $('#sort'),
  shuffle: $('#shuffle'),
  statsBtn: $('#statsBtn'),
  sheetLink: $('#sheetLink'),
  scroller: $('#scroller'),
  scrollerWrap: $('#scrollerWrap'),
  grid: $('#grid'),
  prev: $('#scrollPrev'),
  next: $('#scrollNext'),
  statsModal: $('#statsModal'),
  statsBody: $('#statsBody'),
  cardTpl: $('#cardTpl'),
};

// 2) STATE
const state = {
  all: [],
  filtered: [],
  sortKey: 'title', // 'title' | 'artist'
  view: 'scroll',   // 'scroll' | 'grid'
};

// 3) CSV PARSER (robust enough for quoted fields)
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

// 4) HEADER PICKING (case-insensitive, synonyms)
const HEADER_ALIASES = {
  title:  ["title","album","record","release"],
  artist: ["artist","artists","band"],
  genre:  ["genre","genres","style","category"],
  notes:  ["notes","special notes","comment","comments","description"],
  cover:  ["album artwork","artwork","cover","cover url","image","art","art url","artwork url"],
  alt:    ["alt artwork","alt image","alt cover","alt art"],
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
function looksLikeImage(u){ return /\.(png|jpe?g|webp|gif|avif)(\?|#|$)/i.test(u||""); }

// Use wsrv.nl *only* for real image URLs (not HTML pages)
function wsrv(url){
  // expect a direct image url
  return `https://wsrv.nl/?url=${encodeURIComponent(url)}&w=1000&h=1000&fit=cover&output=webp&q=85`;
}

// If given a Wikipedia page URL, fetch its lead/thumbnail image via REST
async function fromWikipediaPage(pageUrl){
  const m = pageUrl.match(/https?:\/\/(?:\w+\.)?wikipedia\.org\/wiki\/([^?#]+)/i);
  if(!m) return "";
  const title = decodeURIComponent(m[1]);
  try{
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    if(!r.ok) return "";
    const j = await r.json();
    const src = j?.originalimage?.source || j?.thumbnail?.source;
    return src || "";
  }catch{
    return "";
  }
}

// Decide cover for a record based on cells
async function chooseCover(coverRaw, altRaw){
  // prefer Album Artwork cell, then Alt Artwork
  const candidate = coverRaw || altRaw || "";
  if (!candidate) return "";

  if (looksLikeImage(candidate)){
    return wsrv(candidate);
  }

  // If it's a Wikipedia page, ask for lead image
  if (/wikipedia\.org\/wiki\//i.test(candidate)){
    const img = await fromWikipediaPage(candidate);
    return img ? wsrv(img) : "";
  }

  // Unknown (Apple Music / Spotify / shop pages) → skip (no longer wsrv on HTML)
  return "";
}

// Placeholder (while loading / if failing)
function placeholderFor(textA, textB){
  const letter = (textB || textA || "?").trim().charAt(0).toUpperCase() || "?";
  const bg = "#1e2636";
  const fg = "#9fb2d9";
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='1000' height='1000'>
      <rect width='100%' height='100%' fill='${bg}'/>
      <circle cx='500' cy='500' r='380' fill='#141a29'/>
      <text x='50%' y='54%' text-anchor='middle' font-family='Inter,Arial' font-size='420' font-weight='800' fill='${fg}'>${letter}</text>
    </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// 6) LOAD DATA
async function loadFromSheet(){
  const res = await fetch(SHEET_CSV, { cache: "no-store" });
  const text = await res.text();
  if (!text || text.trim().startsWith("<")){
    console.error("Not a CSV export. Make sure your link ends with output=csv");
    return;
  }

  const { data } = parseCSV(text);

  // Normalize
  const records = [];
  for (const row of data){
    const title  = pickField(row, HEADER_ALIASES.title);
    const artist = pickField(row, HEADER_ALIASES.artist);
    const notes  = pickField(row, HEADER_ALIASES.notes);
    const genre  = pickField(row, HEADER_ALIASES.genre);
    const coverRaw = pickField(row, HEADER_ALIASES.cover);
    const altRaw   = pickField(row, HEADER_ALIASES.alt);

    if (!title && !artist) continue;

    records.push({ title, artist, notes, genre, coverRaw, altRaw, cover: "" });
  }

  // Resolve covers (sequential to be gentler on APIs; can be parallel if you prefer)
  for (const r of records){
    try{
      r.cover = await chooseCover(r.coverRaw, r.altRaw);
    }catch{
      r.cover = "";
    }
  }

  state.all = records;
  state.filtered = [...records];
  applySort();
  render();
}

// 7) RENDERING
function createCard(rec){
  // Try template path first
  if (els.cardTpl?.content){
    const node = els.cardTpl.content.firstElementChild.cloneNode(true);
    const titleEl  = node.querySelector('.title');
    const artistEl = node.querySelector('.artist');
    const genreEl  = node.querySelector('.genre');
    const imgEl    = node.querySelector('img.cover');
    const cTitle   = node.querySelector('.caption-title');
    const cArtist  = node.querySelector('.caption-artist');

    titleEl.textContent  = rec.title || "Untitled";
    artistEl.textContent = rec.artist || "Unknown Artist";
    genreEl.textContent  = rec.genre ? `Genre: ${rec.genre}` : "";
    cTitle.textContent   = rec.title || "Untitled";
    cArtist.textContent  = rec.artist || "Unknown Artist";

    const ph = placeholderFor(rec.title, rec.artist);
    imgEl.src = ph;
    imgEl.alt = `${rec.title || "Untitled"} — ${rec.artist || "Unknown Artist"}`;

    // swap to real image when available
    if (rec.cover){
      const real = new Image();
      real.referrerPolicy = 'no-referrer';
      real.onload = () => { imgEl.src = rec.cover; };
      real.onerror = () => { /* keep placeholder */ };
      real.src = rec.cover;
    }

    // flip on click
    node.addEventListener('click', e=>{
      const card = e.currentTarget;
      if (!card) return;
      card.classList.toggle('flipped');
    });

    return node;
  }

  // Fallback (if template missing)
  const card = document.createElement('article');
  card.className = 'card';
  card.innerHTML = `
    <div class="sleeve">
      <div class="face front"><img class="cover" alt=""></div>
      <div class="face back">
        <div class="meta">
          <h3 class="title"></h3>
          <p class="artist"></p>
          <p class="genre"></p>
        </div>
      </div>
    </div>
    <div class="caption">
      <div class="caption-title"></div>
      <div class="caption-artist"></div>
    </div>
  `;
  const titleEl  = card.querySelector('.title');
  const artistEl = card.querySelector('.artist');
  const genreEl  = card.querySelector('.genre');
  const imgEl    = card.querySelector('img.cover');
  const cTitle   = card.querySelector('.caption-title');
  const cArtist  = card.querySelector('.caption-artist');

  titleEl.textContent  = rec.title || "Untitled";
  artistEl.textContent = rec.artist || "Unknown Artist";
  genreEl.textContent  = rec.genre ? `Genre: ${rec.genre}` : "";
  cTitle.textContent   = rec.title || "Untitled";
  cArtist.textContent  = rec.artist || "Unknown Artist";

  const ph = placeholderFor(rec.title, rec.artist);
  imgEl.src = ph;
  imgEl.alt = `${rec.title || "Untitled"} — ${rec.artist || "Unknown Artist"}`;

  if (rec.cover){
    const real = new Image();
    real.referrerPolicy = 'no-referrer';
    real.onload = () => { imgEl.src = rec.cover; };
    real.onerror = () => {};
    real.src = rec.cover;
  }

  card.addEventListener('click', ()=> card.classList.toggle('flipped'));
  return card;
}

function renderScroll(){
  els.scroller.innerHTML = '';
  state.filtered.forEach(rec => els.scroller.appendChild(createCard(rec)));
}

function renderGrid(){
  els.grid.innerHTML = '';
  state.filtered.forEach(rec => els.grid.appendChild(createCard(rec)));
}

function render(){
  const scrollActive = state.view === 'scroll';
  $('#scrollView').classList.toggle('active', scrollActive);
  $('#gridView').classList.toggle('active', !scrollActive);
  els.viewScrollBtn.classList.toggle('active', scrollActive);
  els.viewGridBtn.classList.toggle('active', !scrollActive);

  if (scrollActive){
    renderScroll();
    toggleArrows(true);
  } else {
    renderGrid();
    toggleArrows(false);
  }
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
  applySort();
  render();
});
els.sort.addEventListener('change', ()=>{
  state.sortKey = els.sort.value || 'title';
  applySort();
  render();
});
els.shuffle.addEventListener('click', ()=>{
  for (let i = state.filtered.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [state.filtered[i], state.filtered[j]] = [state.filtered[j], state.filtered[i]];
  }
  render();
});

// 9) VIEW TOGGLES
els.viewScrollBtn.addEventListener('click', ()=>{
  state.view = 'scroll';
  render();
});
els.viewGridBtn.addEventListener('click', ()=>{
  state.view = 'grid';
  render();
});

// 10) ARROWS (for Scroll only)
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
      const parts = String(r.genre).split(/[\/,&]| and /i).map(s=>s.trim()).filter(Boolean);
      for (const g of parts) genreMap.set(g, (genreMap.get(g)||0)+1);
    }
  }
  const topArtists = [...artistMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10);
  const topGenres  = [...genreMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12);
  return { total, uniqArtists: artistMap.size, topArtists, topGenres };
}
function openStats(){
  const s = buildStats(state.filtered);
  const body = els.statsBody;
  body.innerHTML = '';

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

// 12) START
loadFromSheet().catch(err=>{
  console.error(err);
  alert("Couldn’t load the Google Sheet. Make sure your link is published as CSV (output=csv).");
});
