/* Vinyl Collection — app.js (full drop-in)
   - Starts scroller at first card
   - Mobile no hidden leading items
   - Uses /api/art for Apple/Wiki/direct images (server-side)
   - Fast-ish parallel hydrate with throttling
*/

const SHEET_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?output=csv";

const HEADER_ALIASES = {
  title:  ["title","album","record","release"],
  artist: ["artist","artists","band"],
  genre:  ["genre","genres","style","category"],
  notes:  ["notes","special notes","comment","comments","description"],
  cover:  ["album artwork","artwork","cover","cover url","image","art","art url","artwork url"]
};

// ---- Elements (match your index.html ids) ----
const $  = (s, r=document) => r.querySelector(s);
const els = {
  search:     $('#search'),
  viewScroll: $('#view-scroll'),
  viewGrid:   $('#view-grid'),
  sort:       $('#sort'),
  shuffle:    $('#shuffle'),
  sheetLink:  $('#sheetLink'),
  statsBtn:   $('#statsBtn'),

  scroller:   $('#scroller'),
  grid:       $('#grid'),
  prev:       $('#scrollPrev'),
  next:       $('#scrollNext'),

  statsModal: $('#statsModal'),
  statsBody:  $('#statsBody'),
  cardTpl:    $('#cardTpl')
};

// ---- Utilities ----
function normalizeHeader(h){ return (h||"").trim().toLowerCase(); }
function pick(obj, keys){
  for(const k of keys){
    const hit = Object.keys(obj).find(h => normalizeHeader(h) === k);
    if(hit && String(obj[hit]).trim()) return String(obj[hit]).trim();
  }
  return "";
}
const looksLikeImage = (u) => /\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(u || "");
const wsrv = (u) => {
  if(!u) return "";
  const noProto = u.replace(/^https?:\/\//i,"");
  return `https://wsrv.nl/?url=${encodeURIComponent("ssl:"+noProto)}&w=1000&h=1000&fit=cover&output=webp&q=85`;
};
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
// server-side resolver (Apple Music pages, Wikipedia, direct image, iTunes fallback)
async function resolveArt(artist, title, coverHint){
  const url = `/api/art?artist=${encodeURIComponent(artist||"")}&title=${encodeURIComponent(title||"")}&cover=${encodeURIComponent(coverHint||"")}`;
  try{
    const r = await fetch(url, { cache: "no-store" });
    if(!r.ok) return { cover:"", genre:"" };
    return await r.json(); // { cover, genre }
  }catch{
    return { cover:"", genre:"" };
  }
}

// ---- State ----
const state = {
  all: [],
  filtered: [],
  view: 'scroll',    // 'scroll' | 'grid'
  sortKey: 'title'
};

// ---- CSV load & hydrate (with light throttling) ----
async function loadFromSheet(){
  const text = await fetch(SHEET_CSV, { cache: "no-store" }).then(r => r.text());
  // Simple robust CSV parser (header:true)
  const rows = parseCSV(text);

  // Normalize + pick columns
  const base = rows.map(r=>{
    const title   = pick(r, HEADER_ALIASES.title);
    const artist  = pick(r, HEADER_ALIASES.artist);
    const genre   = pick(r, HEADER_ALIASES.genre);
    const notes   = pick(r, HEADER_ALIASES.notes);
    const coverRaw= pick(r, HEADER_ALIASES.cover);
    return { title, artist, genre, notes, coverRaw, cover:"" };
  }).filter(x => x.title || x.artist);

  // Hydrate artwork/genre (throttle concurrency to avoid spikes)
  const CONCURRENCY = 10;
  const out = [];
  let i = 0;
  async function workOne(rec){
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
      const { cover:c2, genre:g2 } = await resolveArt(rec.artist, rec.title, rec.coverRaw);
      cover = cover || c2;
      genre = genre || g2;
    }

    out.push({ ...rec, cover, genre });
  }
  async function runner(){
    while(i < base.length){
      const start = i;
      const batch = base.slice(start, start+CONCURRENCY);
      i += CONCURRENCY;
      await Promise.all(batch.map(workOne));
      // render progressively for perceived speed
      state.all = out.slice();
      state.filtered = state.all.slice();
      applySort();
      render(true); // progressive render
    }
  }
  await runner();

  // final render, ensure scroll sits at first item
  render();
  snapToStart();
}

// ---- Renderers ----
function createCard(rec){
  const tpl = els.cardTpl.content.cloneNode(true);
  const art = tpl.querySelector('.cover');
  const t   = tpl.querySelector('.title');
  const a   = tpl.querySelector('.artist');
  const g   = tpl.querySelector('.genre');
  const capT= tpl.querySelector('.caption-title');
  const capA= tpl.querySelector('.caption-artist');

  const title  = rec.title  || "Untitled";
  const artist = rec.artist || "Unknown Artist";

  art.src = rec.cover || "";
  art.alt = `${title} — ${artist}`;
  t.textContent = title;
  a.textContent = artist;
  g.textContent = rec.genre ? rec.genre : "";
  capT.textContent = title;
  capA.textContent = artist;

  // Optional notes (smaller, muted)
  if(rec.notes){
    const meta = tpl.querySelector('.meta');
    const p = document.createElement('p');
    p.className = 'notes';
    p.textContent = rec.notes;
    meta.appendChild(p);
  }

  const card = tpl.querySelector('.card');
  card.addEventListener('click', ()=> card.classList.toggle('flipped'));
  return tpl;
}

function renderScroll(progressive=false){
  if(!progressive) els.scroller.innerHTML = "";
  const frag = document.createDocumentFragment();
  state.filtered.forEach(rec => frag.appendChild(createCard(rec)));
  els.scroller.replaceChildren(frag);
  // Always ensure we start at first card
  snapToStart();
}
function renderGrid(){
  const frag = document.createDocumentFragment();
  state.filtered.forEach(rec => frag.appendChild(createCard(rec)));
  els.grid.replaceChildren(frag);
}
function render(progressive=false){
  if(state.view === 'scroll'){
    $('#scrollView')?.classList.add('active');
    $('#gridView')?.classList.remove('active');
    renderScroll(progressive);
    toggleArrows(true);
  }else{
    $('#scrollView')?.classList.remove('active');
    $('#gridView')?.classList.add('active');
    renderGrid();
    toggleArrows(false);
  }
}
function snapToStart(){
  // Remove any hidden-leading gap effects. Start at leftmost.
  if(els.scroller){
    els.scroller.scrollTo({ left: 0, behavior: 'auto' });
  }
}
function toggleArrows(show){
  $('#scrollPrev').style.display = show ? "" : "none";
  $('#scrollNext').style.display = show ? "" : "none";
}

// ---- Search / Sort / Shuffle ----
els.search.addEventListener('input', e=>{
  const q = e.target.value.trim().toLowerCase();
  state.filtered = state.all.filter(r=>{
    const hay = `${r.title} ${r.artist} ${r.genre} ${r.notes}`.toLowerCase();
    return hay.includes(q);
  });
  applySort();
  render();
});

function setSortKey(key){
  state.sortKey = key;
  // keep the <select> text centered by just selecting the option
  if(els.sort) els.sort.value = key;
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
els.sort.addEventListener('change', ()=> setSortKey(els.sort.value || 'title'));
els.shuffle.addEventListener('click', ()=>{
  for(let i=state.filtered.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [state.filtered[i], state.filtered[j]] = [state.filtered[j], state.filtered[i]];
  }
  render();
});

// ---- View toggles ----
els.viewScroll.addEventListener('click', ()=>{
  state.view = 'scroll';
  els.viewScroll.classList.add('active');
  els.viewGrid.classList.remove('active');
  render();
});
els.viewGrid.addEventListener('click', ()=>{
  state.view = 'grid';
  els.viewGrid.classList.add('active');
  els.viewScroll.classList.remove('active');
  render();
});

// ---- Arrows (scroll by ~90% width) ----
function smoothScrollBy(px){ els.scroller?.scrollBy({ left: px, behavior: 'smooth' }); }
els.prev.addEventListener('click', ()=> smoothScrollBy(-Math.round(els.scroller.clientWidth*0.9)));
els.next.addEventListener('click', ()=> smoothScrollBy( Math.round(els.scroller.clientWidth*0.9)));

// ---- Stats ----
function buildStats(recs){
  const total = recs.length;
  const artistMap = new Map();
  const genreMap  = new Map();
  for(const r of recs){
    if(r.artist) artistMap.set(r.artist, (artistMap.get(r.artist)||0)+1);
    if(r.genre){
      const parts = String(r.genre).split(/[\/,&]| and /i).map(s=>s.trim()).filter(Boolean);
      for(const g of parts){ genreMap.set(g, (genreMap.get(g)||0)+1); }
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
    const chips = document.createElement('div'); chips.className='chips';
    s.topArtists.forEach(([name,n])=>{
      const c=document.createElement('span'); c.className='chip'; c.textContent=`${name} • ${n}`;
      chips.appendChild(c);
    });
    body.appendChild(chips);
  }

  if (s.topGenres.length){
    const h = document.createElement('h3'); h.textContent='Top Genres'; body.appendChild(h);
    const chips = document.createElement('div'); chips.className='chips';
    s.topGenres.forEach(([g,n])=>{
      const c=document.createElement('span'); c.className='chip'; c.textContent=`${g} • ${n}`;
      chips.appendChild(c);
    });
    body.appendChild(chips);
  }

  // top-right Close button
  let actions = $('.dialog-actions', els.statsModal);
  if(!actions){
    actions = document.createElement('div');
    actions.className = 'dialog-actions';
    els.statsModal.querySelector('.stats-card').appendChild(actions);
  }
  actions.innerHTML = '';
  const close = document.createElement('button');
  close.className = 'dialog-close';
  close.textContent = 'Close';
  close.addEventListener('click', ()=> els.statsModal.close());
  actions.appendChild(close);

  els.statsModal.showModal();
}
els.statsBtn.addEventListener('click', openStats);

// ---- Kickoff ----
loadFromSheet().catch(console.error);

// ---- tiny CSV parser (header row → objects) ----
function parseCSV(text){
  const rows = [];
  let cur = [''];
  let inQ = false;
  for (let i=0;i<text.length;i++){
    const c=text[i];
    if(c === '"'){
      if(inQ && text[i+1] === '"'){ cur[cur.length-1] += '"'; i++; }
      else inQ = !inQ;
    }else if(c === ',' && !inQ){
      cur.push('');
    }else if((c === '\n' || c === '\r') && !inQ){
      rows.push(cur); cur=[''];
      if(c==='\r' && text[i+1]==='\n') i++;
    }else{
      cur[cur.length-1] += c;
    }
  }
  if(cur.length>1 || cur[0] !== '') rows.push(cur);
  const header = (rows.shift()||[]).map(normalizeHeader);
  return rows.filter(r => r.some(x=>x && x.trim())).map(r=>{
    const o={}; header.forEach((h,idx)=> o[h] = (r[idx]||'').trim()); return o;
  });
}
