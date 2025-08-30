/* -------------------------------
   Vinyl Collection — app.js (drop-in)
   Works with your Google Sheet:
   https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?output=csv
---------------------------------*/

// ---- 0) Config ----
const SHEET_CSV =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?output=csv";

const HEADER_ALIASES = {
  title:  ["title","album","record","release"],
  artist: ["artist","artists","band"],
  genre:  ["genre","genres","style","category"],
  notes:  ["notes","special notes","comment","comments","description"],
  cover:  ["album artwork","artwork","cover","cover url","image","art","art url","artwork url"]
};

// ---- 1) Element wiring (be forgiving) ----
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];

const els = {
  search: $('#search') || $('input[placeholder="Search"]'),
  viewScroll: $('#viewScroll') || $$('button,.seg-btn').find(b=>/view:\s*scroll/i.test(b?.textContent||'')),
  viewGrid: $('#viewGrid') || $$('button,.seg-btn').find(b=>/view:\s*grid/i.test(b?.textContent||'')),
  sort: $('#sortSelect') || $$('select,button').find(x=>/sort/i.test(x?.textContent||'')),
  shuffle: $('#btnShuffle') || $$('button').find(b=>/shuffle/i.test(b?.textContent||'')),
  stats: $('#btnStats') || $$('button').find(b=>/stats/i.test(b?.textContent||'')),
  googleSheet: $('#btnSheet') || $$('a,button').find(x=>/google\s*sheet/i.test(x?.textContent||'')),
  main: $('main') || document.body,
  scroller: $('.scroller'),
  grid: $('.grid'),
  leftArrow: $('.nav-arrow.left'),
  rightArrow: $('.nav-arrow.right'),
  statsModal: $('#statsModal'),
  statsBody: $('#statsBody'),
};

// Create missing containers if needed
(function ensureContainers(){
  if(!els.scroller){
    const wrap = document.createElement('section');
    wrap.className = 'scroller-wrap view active';
    wrap.innerHTML = `
      <button class="nav-arrow left" aria-label="Previous"><span class="chev chev-left"></span></button>
      <div class="scroller" id="scroller"></div>
      <button class="nav-arrow right" aria-label="Next"><span class="chev chev-right"></span></button>
    `;
    els.main.appendChild(wrap);
    els.scroller = $('#scroller', wrap);
    els.leftArrow = $('.nav-arrow.left', wrap);
    els.rightArrow = $('.nav-arrow.right', wrap);
  }
  if(!els.grid){
    const g = document.createElement('section');
    g.className = 'grid view';
    g.id = 'grid';
    els.main.appendChild(g);
    els.grid = g;
  }
  if(!els.statsModal){
    const d = document.createElement('dialog');
    d.id = 'statsModal';
    d.innerHTML = `
      <div class="stats-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <h2 style="margin:0">Collection Stats</h2>
          <button id="closeStats" class="btn ghost">Close</button>
        </div>
        <div id="statsBody" class="stats-body"></div>
      </div>`;
    els.main.appendChild(d);
    els.statsModal = d;
    els.statsBody = $('#statsBody', d);
    $('#closeStats', d).addEventListener('click', ()=> d.close());
  }
})();

// ---- 2) State ----
const state = {
  all: [],
  filtered: [],
  view: 'scroll',     // 'scroll' | 'grid'
  sortKey: 'title',   // 'title' | 'artist'
};

// ---- 3) CSV utilities ----
function pick(obj, synonyms){
  for(const key of synonyms){
    const hit = Object.keys(obj).find(h => h.trim().toLowerCase() === key);
    if(hit && String(obj[hit]).trim()) return String(obj[hit]).trim();
  }
  return "";
}

// tiny robust CSV parser (handles quotes)
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
      if (c === '\r' && text[i+1]==='\n') i++; // CRLF
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

// ---- 4) Artwork helpers ----
function wsrv(url){
  if(!url) return "";
  const u = url.replace(/^https?:\/\//, "");
  return `https://wsrv.nl/?url=${encodeURIComponent("ssl:"+u)}&w=1000&h=1000&fit=cover&output=webp&q=85`;
}

function looksLikeImage(u){ return /\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(u||""); }

// Wikipedia page → lead image
async function fromWikipediaPage(pageUrl){
  const m = pageUrl.match(/https?:\/\/(?:\w+\.)?wikipedia\.org\/wiki\/([^?#]+)/i);
  if(!m) return "";
  const title = decodeURIComponent(m[1]);
  try{
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    if(!r.ok) return "";
    const j = await r.json();
    const src = j?.originalimage?.source || j?.thumbnail?.source;
    return src ? wsrv(src) : "";
  }catch{ return ""; }
}

// replace the old fromApple() with this:
async function resolveArt(artist, title, coverHint) {
  const url = `/api/art?artist=${encodeURIComponent(artist || "")}&title=${encodeURIComponent(title || "")}&cover=${encodeURIComponent(coverHint || "")}`;
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return { cover: "", genre: "" };
    return await r.json(); // { cover, genre }
  } catch {
    return { cover: "", genre: "" };
  }
}


// ---- 5) Loader ----
function showStatus(msg){
  let el = $('#status');
  if(!el){
    el = document.createElement('div');
    el.id = 'status';
    el.style.cssText = "margin:24px; padding:14px 16px; border:1px solid #1b2436; background:#0f1727; color:#eef2f8; border-radius:12px; max-width:820px";
    els.main.prepend(el);
  }
  el.textContent = msg;
}

async function loadFromSheet(){
  try{
    const res = await fetch(SHEET_CSV, { cache: "no-store" });
    const text = await res.text();

    if(text.trim().startsWith("<")){
      showStatus("Your Google Sheet link is not CSV. Use File → Publish to web → CSV (ends with output=csv).");
      return;
    }

    const parsed = parseCSV(text);
    const rows = parsed.data;

    const normalized = rows.map(r => {
      const title  = pick(r, HEADER_ALIASES.title);
      const artist = pick(r, HEADER_ALIASES.artist);
      const genre  = pick(r, HEADER_ALIASES.genre);
      const notes  = pick(r, HEADER_ALIASES.notes);
      const coverRaw = pick(r, HEADER_ALIASES.cover);
      return { title, artist, genre, notes, coverRaw };
    }).filter(x => x.title || x.artist);

    // hydrate artwork + genre
    for (const rec of normalized){
      let cover = "";
      let genre = rec.genre || "";

      if(rec.coverRaw){
        if(looksLikeImage(rec.coverRaw)){
          cover = wsrv(rec.coverRaw);
        } else if (/wikipedia\.org\/wiki\//i.test(rec.coverRaw)){
          cover = await fromWikipediaPage(rec.coverRaw);
        }
      }
      if(!cover || !genre){
        const { cover:c2, genre:g2 } = await fromApple(rec.artist, rec.title);
        cover = cover || c2;
        genre = genre || g2;
      }
      rec.cover = cover;
      rec.genre = genre;
    }

    state.all = normalized;
    state.filtered = [...normalized];
    render();
  }catch(e){
    console.error(e);
    showStatus("Couldn’t load your Google Sheet. Check the URL or try again.");
  }
}

// ---- 6) Renderers ----
function cardHTML(rec, idx){
  const safeTitle  = rec.title || "Untitled";
  const safeArtist = rec.artist || "Unknown Artist";
  const cover = rec.cover || "";
  const back = `
    <div style="padding:16px;text-align:center">
      <h3 style="margin-top:0">${safeTitle}</h3>
      <p style="margin:4px 0 10px;color:#b7c2d7">${safeArtist}</p>
      ${rec.genre ? `<div class="genre">${rec.genre}</div>` : ""}
      ${rec.notes ? `<p style="margin-top:12px;white-space:pre-wrap">${rec.notes}</p>` : ""}
    </div>
  `;
  return `
    <div class="card" data-idx="${idx}" tabindex="0">
      <div class="sleeve">
        <div class="face front">
          <img class="cover" loading="lazy" decoding="async" alt="${safeTitle} — ${safeArtist}" src="${cover || ''}">
        </div>
        <div class="face back">${back}</div>
      </div>
      <div class="caption">
        <div class="caption-title">${safeTitle}</div>
        <div class="caption-artist">${safeArtist}</div>
      </div>
    </div>
  `;
}

function renderScroll(){
  els.scroller.innerHTML = state.filtered.map((r,i)=>cardHTML(r,i)).join('');
  bindCardFlips(els.scroller);
}

function renderGrid(){
  els.grid.innerHTML = state.filtered.map((r,i)=>cardHTML(r,i)).join('');
  bindCardFlips(els.grid);
}

function render(){
  if(state.view === 'scroll'){
    $('.view.scroller-wrap')?.classList.add('active');
    els.grid?.classList.remove('active');
    renderScroll();
    toggleArrows(true);
  } else {
    $('.view.scroller-wrap')?.classList.remove('active');
    els.grid?.classList.add('active');
    renderGrid();
    toggleArrows(false);
  }
}

function bindCardFlips(root){
  root.addEventListener('click', (e)=>{
    const card = e.target.closest('.card');
    if(!card) return;
    card.classList.toggle('flipped');
  });
}

// ---- 7) UI behaviors ----
function toggleArrows(show){
  if(els.leftArrow)  els.leftArrow.style.display  = show ? '' : 'none';
  if(els.rightArrow) els.rightArrow.style.display = show ? '' : 'none';
}

function smoothScrollBy(px){
  els.scroller?.scrollBy({ left: px, behavior: 'smooth' });
}

// Search
els.search && els.search.addEventListener('input', (e)=>{
  const q = e.target.value.trim().toLowerCase();
  state.filtered = state.all.filter(r=>{
    const hay = `${r.title} ${r.artist} ${r.genre} ${r.notes}`.toLowerCase();
    return hay.includes(q);
  });
  applySort();
  render();
});

// Sort (supports a <select> or a toggle button with text)
function setSortKey(key){
  state.sortKey = key;
  if(els.sort && els.sort.tagName === 'BUTTON'){
    els.sort.textContent = `Sort: ${key[0].toUpperCase()+key.slice(1)}`;
  }
  applySort(); render();
}
function applySort(){
  const k = state.sortKey;
  state.filtered.sort((a,b)=>{
    const A = (a[k]||"").toLowerCase();
    const B = (b[k]||"").toLowerCase();
    return A.localeCompare(B);
  });
}

// Sort binding
if(els.sort){
  if(els.sort.tagName === 'SELECT'){
    // expect options value = title|artist
    els.sort.addEventListener('change', ()=> setSortKey(els.sort.value || 'title'));
  } else {
    // toggle Title <-> Artist on button click
    els.sort.addEventListener('click', ()=>{
      setSortKey(state.sortKey === 'title' ? 'artist' : 'title');
    });
  }
}

// Shuffle
els.shuffle && els.shuffle.addEventListener('click', ()=>{
  for(let i=state.filtered.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [state.filtered[i], state.filtered[j]] = [state.filtered[j], state.filtered[i]];
  }
  render();
});

// View toggles
els.viewScroll && els.viewScroll.addEventListener('click', ()=>{
  state.view = 'scroll';
  els.viewScroll?.classList.add('active');
  els.viewGrid?.classList.remove('active');
  render();
});
els.viewGrid && els.viewGrid.addEventListener('click', ()=>{
  state.view = 'grid';
  els.viewGrid?.classList.add('active');
  els.viewScroll?.classList.remove('active');
  render();
});

// Arrows (only for scroll)
els.leftArrow && els.leftArrow.addEventListener('click', ()=> smoothScrollBy(-Math.round(els.scroller.clientWidth*0.9)));
els.rightArrow && els.rightArrow.addEventListener('click',()=> smoothScrollBy(Math.round(els.scroller.clientWidth*0.9)));

// ---- 8) Stats ----
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
  const topArtists = [...artistMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10);
  const topGenres  = [...genreMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12);
  return { total, uniqArtists: artistMap.size, topArtists, topGenres };
}

function openStats(){
  const s = buildStats(state.filtered);
  const body = els.statsBody; body.innerHTML = "";

  const grid = document.createElement('div'); grid.className='stat-grid';
  const totalGenres = s.topGenres.length;
  grid.innerHTML = `
    <div class="stat-tile"><div>Total Albums</div><div class="stat-big">${s.total}</div></div>
    <div class="stat-tile"><div>Unique Artists</div><div class="stat-big">${s.uniqArtists}</div></div>
    <div class="stat-tile"><div>Total Genres</div><div class="stat-big">${totalGenres}</div></div>
  `;
  body.appendChild(grid);

  if (s.topArtists.length){
    const h = document.createElement('h3'); h.textContent='Top Artists'; body.appendChild(h);
    const ul = document.createElement('ul'); ul.style.listStyle='none'; ul.style.padding=0;
    s.topArtists.forEach(([name,n])=>{
      const li=document.createElement('li'); li.textContent=`${name} — ${n}`; ul.appendChild(li);
    });
    body.appendChild(ul);
  }

  if (s.topGenres.length){
    const h = document.createElement('h3'); h.textContent='Top Genres'; body.appendChild(h);
    const chips = document.createElement('div'); chips.className='chips';
    s.topGenres.forEach(([g,n])=>{
      const c=document.createElement('span'); c.className='chip'; c.textContent=`${g} • ${n}`; chips.appendChild(c);
    });
    body.appendChild(chips);
  } else {
    const p=document.createElement('p'); p.textContent='No genres found. Add a "Genre" column in the sheet to see genre stats.'; body.appendChild(p);
  }

  els.statsModal.showModal();
}
els.stats && els.stats.addEventListener('click', openStats);

// ---- 9) Kickoff ----
loadFromSheet();
applySort(); // default title
