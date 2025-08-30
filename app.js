// Your published CSV:
const SHEET_CSV = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?gid=0&single=true&output=csv';

// Placeholder image (SVG data URI)
const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
     <defs><linearGradient id="g" x1="0" x2="1">
       <stop offset="0%" stop-color="#111a36"/><stop offset="100%" stop-color="#0b1228"/></linearGradient>
     </defs>
     <rect width="100%" height="100%" fill="url(#g)"/>
     <circle cx="200" cy="200" r="110" fill="#141f40"/>
     <text x="50%" y="52%" text-anchor="middle" fill="#a5b4fc" font-size="42" font-family="system-ui">🎵</text>
   </svg>`
);

const state = { all: [], filtered: [], view: 'scroll', sort: 'title' };
const $  = s => document.querySelector(s);
const el = (t,c) => { const n=document.createElement(t); if(c) n.className=c; return n; };

/* ---------- Helpers ---------- */
function sanitizeCoverURL(u){
  if(!u) return '';
  try{
    u = (''+u).trim();

    // Google Drive file id → direct download
    const m = u.match(/[-\w]{25,}/);
    if (u.includes('drive.google.com') && m){
      return `https://drive.google.com/uc?export=download&id=${m[0]}`;
    }
    // Dropbox share → raw
    if (u.includes('dropbox.com')){
      return u.replace('www.dropbox.com','dl.dropboxusercontent.com').replace('?dl=0','');
    }
    return u;
  }catch{ return (''+u); }
}

function csvToArray(text){
  const out = Papa.parse(text, { header:true, skipEmptyLines:true });
  return out.data;
}

async function fetchSheet(){
  const res  = await fetch(SHEET_CSV, { cache: 'no-store' });
  const text = await res.text();
  const rows = csvToArray(text);

  return rows.map(r=>{
    const title = (r.Title  || r.Album || r.album || '').trim();
    const artist= (r.Artist || r.artist || '').trim();
    const cover = sanitizeCoverURL((r.Cover || r.Image || r.Art || '').trim());
    const genre = (r.Genre || r.genre || '').trim();
    return { title, artist, cover, genre };
  }).filter(x => x.title && x.artist);
}

const keyFor = r => `${r.artist.toLowerCase().trim()}::${r.title.toLowerCase().trim()}`;
const getCachedArt = k => localStorage.getItem('art:'+k) || '';
const setCachedArt = (k,u) => { try{ localStorage.setItem('art:'+k,u); }catch{} };

/* iTunes fallback: cross-origin friendly */
async function fetchItunesArt(artist, title){
  const term = encodeURIComponent(`${artist} ${title}`);
  const url  = `https://itunes.apple.com/search?term=${term}&entity=album&limit=1`;
  try{
    const j = await fetch(url, { cache:'force-cache' }).then(r=>r.json());
    const hit = j.results && j.results[0];
    if (!hit) return '';
    // upsize: 100x100bb.jpg → 600x600bb.jpg
    return hit.artworkUrl100.replace('100x100bb', '600x600bb');
  }catch{
    return '';
  }
}

/* Build one card */
function makeCard(rec){
  const tpl = $('#cardTpl');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.querySelector('.title').textContent  = rec.title;
  node.querySelector('.artist').textContent = rec.artist;
  node.querySelector('.genre').textContent  = rec.genre ? `Genre: ${rec.genre}` : '';

  node.querySelector('.caption-title').textContent  = rec.title;
  node.querySelector('.caption-artist').textContent = rec.artist;

  const img = node.querySelector('img.cover');
  const k   = keyFor(rec);
  const cached = getCachedArt(k);

  // Initial source: cache → sheet cover → placeholder
  img.src = cached || rec.cover || PLACEHOLDER;
  img.alt = `${rec.title} — ${rec.artist}`;

  // If image fails OR we don't have a cover, try iTunes
  async function upgradeFromItunes(){
    const url = await fetchItunesArt(rec.artist, rec.title);
    if (url){
      img.src = url;
      setCachedArt(k, url);
    } else {
      img.src = PLACEHOLDER;
    }
  }

  if (!cached && !rec.cover){
    // no cover provided → try iTunes immediately
    upgradeFromItunes();
  }

  img.addEventListener('error', ()=> upgradeFromItunes(), { once:true });
  node.querySelector('.sleeve').addEventListener('click', ()=> node.classList.toggle('flipped'));
  return node;
}

function enableWheelHScroll(scroller){
  scroller.addEventListener('wheel', (e) => {
    const absY = Math.abs(e.deltaY), absX = Math.abs(e.deltaX);
    if (absY > absX){
      e.preventDefault();
      scroller.scrollLeft += e.deltaY;
    }
  }, { passive: false });
}

/* Render */
function render(){
  const list = state.filtered.slice();

  // sorting
  list.sort((a,b)=>{
    if (state.sort==='artist') return a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title);
    return a.title.localeCompare(b.title) || a.artist.localeCompare(b.artist);
  });

  const scroller = $('#scroller');
  scroller.innerHTML=''; const f1=document.createDocumentFragment();
  list.forEach(r=>f1.appendChild(makeCard(r))); scroller.appendChild(f1);

  const grid = $('#grid');
  grid.innerHTML=''; const f2=document.createDocumentFragment();
  list.forEach(r=>f2.appendChild(makeCard(r))); grid.appendChild(f2);

  enableWheelHScroll(scroller);
}

/* View + controls */
function setView(mode){
  state.view = mode;
  $('#scrollView').classList.toggle('active', mode==='scroll');
  $('#gridView').classList.toggle('active',   mode==='grid');
  $('#view-scroll').classList.toggle('active', mode==='scroll');
  $('#view-grid').classList.toggle('active',   mode==='grid');
}

function applyFilter(q){
  q = (q||'').trim().toLowerCase();
  state.filtered = !q ? state.all.slice()
    : state.all.filter(r => r.title.toLowerCase().includes(q) || r.artist.toLowerCase().includes(q) || (r.genre||'').toLowerCase().includes(q));
  render();
}

function shuffle(){
  const a = state.filtered;
  for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  render();
}

function nextCard(dir=1){
  if (state.view !== 'scroll') return;
  const scroller = $('#scroller');
  const cards = Array.from(scroller.children);
  if (!cards.length) return;
  const current = scroller.scrollLeft;
  let target = null;
  if (dir>0){
    target = cards.find(c => c.offsetLeft - current > 8) || cards[cards.length-1];
  }else{
    for (let i=cards.length-1;i>=0;i--){ if (current - cards[i].offsetLeft > 8){ target = cards[i]; break; } }
    if (!target) target = cards[0];
  }
  scroller.scrollTo({ left: target.offsetLeft, behavior: 'smooth' });
}

/* Stats */
function buildStats(items){
  const total = items.length;
  const uniqArtists = new Set(items.map(r=>r.artist)).size;

  const artistCounts = new Map();
  const genreCounts  = new Map();
  items.forEach(r=>{
    artistCounts.set(r.artist, (artistCounts.get(r.artist)||0)+1);
    const g=(r.genre||'').trim(); if(g) genreCounts.set(g,(genreCounts.get(g)||0)+1);
  });

  const topArtists = Array.from(artistCounts.entries()).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const topGenres  = Array.from(genreCounts.entries()).sort((a,b)=>b[1]-a[1]);

  return { total, uniqArtists, topArtists, topGenres };
}

function openStats(){
  const s = buildStats(state.filtered);
  const body = $('#statsBody'); body.innerHTML='';

  // tiles
  const grid = el('div','stat-grid');
  grid.innerHTML = `
    <div class="stat-tile"><div>Total Albums</div><div class="stat-big">${s.total}</div></div>
    <div class="stat-tile"><div>Unique Artists</div><div class="stat-big">${s.uniqArtists}</div></div>
    <div class="stat-tile">
      <div>Library Progress</div>
      <div class="bar"><span style="width:${Math.min(100, (s.topGenres.length? (s.topGenres[0][1]/s.total*100):0)).toFixed(0)}%"></span></div>
    </div>
  `;
  body.appendChild(grid);

  // top artists
  if (s.topArtists.length){
    const h = el('h3'); h.textContent='Top Artists'; body.appendChild(h);
    const ul = el('ul'); ul.style.listStyle='none'; ul.style.padding=0;
    s.topArtists.forEach(([name,n])=>{
      const li=el('li'); li.textContent=`${name} — ${n}`;
      ul.appendChild(li);
    });
    body.appendChild(ul);
  }

  // top genres as chips
  if (s.topGenres.length){
    const h = el('h3'); h.textContent='Top Genres'; body.appendChild(h);
    const chips = el('div','chips');
    s.topGenres.forEach(([g,n])=>{
      const c=el('span','chip'); c.textContent=`${g} • ${n}`;
      chips.appendChild(c);
    });
    body.appendChild(chips);
  } else {
    const p=el('p'); p.textContent='No genres found. Add a "Genre" column in the sheet to see genre stats.'; body.appendChild(p);
  }

  $('#statsModal').showModal();
}

/* ---------- Init ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  const search = $('#search');

  $('#view-scroll').addEventListener('click', ()=> setView('scroll'));
  $('#view-grid').addEventListener('click',  ()=> setView('grid'));
  $('#shuffle').addEventListener('click',    shuffle);
  $('#statsBtn').addEventListener('click',   openStats);

  $('#sort').addEventListener('change', (e)=>{ state.sort = e.target.value; render(); });

  $('#scrollPrev').addEventListener('click', ()=> nextCard(-1));
  $('#scrollNext').addEventListener('click', ()=> nextCard(1));

  search.addEventListener('input', e => applyFilter(e.target.value));

  try{
    state.all = await fetchSheet();
    state.filtered = state.all.slice();
    setView('scroll');
    render();
  }catch(e){
    console.error(e);
    alert('Could not load your Google Sheet. Make sure it is published as CSV.');
  }

  document.addEventListener('keydown', (e)=>{
    if (state.view!=='scroll') return;
    if (e.key==='ArrowRight') nextCard(1);
    if (e.key==='ArrowLeft')  nextCard(-1);
  });
});
