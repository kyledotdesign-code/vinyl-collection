/* -------------------------------------------------------
   Vinyl Collection — fixed image proxy + wiki resolve + fallback
   CSV:
   https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?output=csv
--------------------------------------------------------*/

// ---------- 0) Config ----------
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

// Neutral placeholder (SVG data URL)
const PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <defs><radialGradient id="g" cx="50%" cy="50%" r="60%">
      <stop offset="0%" stop-color="#2a3140"/><stop offset="100%" stop-color="#121722"/>
    </radialGradient></defs>
    <circle cx="50" cy="50" r="48" fill="url(#g)"/>
    <circle cx="50" cy="50" r="8" fill="#0a0f17" stroke="#444e60" stroke-width="2"/>
    <circle cx="50" cy="50" r="2.5" fill="#ddd"/>
  </svg>`);

// ---------- 1) Elements ----------
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];

const els = {
  header:     $('#siteHeader'),
  search:     $('#search'),
  viewScroll: $('#viewScroll'),
  viewGrid:   $('#viewGrid'),
  sort:       $('#sortSelect'),
  shuffle:    $('#btnShuffle'),
  statsBtn:   $('#btnStats'),
  grid:       $('#grid'),
  scroller:   $('#scroller'),
  statsDlg:   $('#statsModal'),
  statsBody:  $('#statsBody'),
  tpl:        $('#cardTpl')
};

// keep layout correct with fixed header
function applyHeaderOffset(){
  const h = els.header?.offsetHeight || 120;
  document.body.style.setProperty('--header-h', `${h}px`);
  document.body.classList.add('has-fixed-header');
}
window.addEventListener('load', applyHeaderOffset);
window.addEventListener('resize', applyHeaderOffset);

// ---------- 2) State ----------
const state = { all: [], filtered: [], view: 'scroll', sortKey: 'title' };

// ---------- 3) CSV parsing ----------
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

// ---------- 4) Image helpers ----------
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i;
function isImageUrl(u){ return IMG_EXT_RE.test(u||""); }
function isWikipediaPage(u){ return /^https?:\/\/[^/]*wikipedia\.org\/wiki\/[^]+/i.test(u||""); }

// Correct weserv proxy format: images.weserv.nl + ssl: + no protocol
function weserv(url){
  if(!url) return "";
  const stripped = url.replace(/^https?:\/\//,'');
  return `https://images.weserv.nl/?url=ssl:${stripped}&w=1000&h=1000&fit=cover&output=webp&q=85`;
}

async function wikipediaLeadImage(pageUrl){
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

// Return BOTH proxy and direct; we'll try proxy, then fall back to direct on error
async function resolveCover(raw){
  const url = (raw||"").trim();
  if(!url) return { prox:"", direct:"" };
  if(isImageUrl(url)) return { prox: weserv(url), direct: url };
  if(isWikipediaPage(url)){
    const lead = await wikipediaLeadImage(url);
    return lead ? { prox: weserv(lead), direct: lead } : { prox:"", direct:"" };
  }
  return { prox:"", direct:"" }; // non-image pages like Apple Music → no scrape
}

// ---------- 5) Loader ----------
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
      showStatus("Your Google Sheet link is not CSV. Use File → Publish to web → CSV (ends with output=csv).");
      return;
    }

    const { data } = parseCSV(text);
    const normalized = data.map(r => {
      const title    = pick(r, HEADER_ALIASES.title);
      const artist   = pick(r, HEADER_ALIASES.artist);
      const genre    = pick(r, HEADER_ALIASES.genre);
      const notes    = pick(r, HEADER_ALIASES.notes);
      const coverRaw = pick(r, HEADER_ALIASES.cover);
      const altRaw   = pick(r, HEADER_ALIASES.altCover);
      const cover    = coverRaw || altRaw || "";
      return { title, artist, genre, notes, cover, prox:"", direct:"" };
    }).filter(x => x.title || x.artist);

    state.all = normalized;
    state.filtered = [...normalized];
    applySort();
    render();                // render immediately with placeholders
    $('#status')?.remove();

    // progressively hydrate covers (limit concurrency)
    hydrateCovers(state.all, 8);
  }catch(e){
    console.error(e);
    showStatus("Couldn’t load your Google Sheet. Check the URL or try again.");
  }
}

// Progressive hydration with a concurrency cap
async function hydrateCovers(recs, limit=8){
  let idx = 0;
  async function worker(){
    while(idx < recs.length){
      const i = idx++;
      const { prox, direct } = await resolveCover(recs[i].cover);
      recs[i].prox = prox;
      recs[i].direct = direct;
      updateCardImage(i, prox, direct);
    }
  }
  await Promise.all(Array.from({length:Math.max(1,Math.min(limit,recs.length))}, worker));
}

// Update image for a specific card index
function updateCardImage(i, proxUrl, directUrl){
  const roots = [els.scroller, els.grid];
  for(const root of roots){
    if(!root) continue;
    const card = root.querySelector(`.card[data-idx="${i}"]`);
    if(!card) continue;
    const img = card.querySelector('.cover');
    // try proxy first; if it errors, try direct; else placeholder
    let triedDirect = false;
    img.onerror = ()=>{
      if(!triedDirect && directUrl){
        triedDirect = true;
        img.src = directUrl; // fallback to direct
      }else{
        img.src = PLACEHOLDER;
      }
      card.classList.add('loaded');
    };
    img.onload = ()=> card.classList.add('loaded');
    img.src = proxUrl || directUrl || PLACEHOLDER;
    break;
  }
}

// ---------- 6) Rendering ----------
function createCard(rec, idx){
  const tpl = els.tpl.content.cloneNode(true);
  const card   = tpl.querySelector('.card');
  const img    = tpl.querySelector('.cover');
  const titleE = tpl.querySelector('.title');
  const artistE= tpl.querySelector('.artist');
  const genreE = tpl.querySelector('.genre');
  const notesE = tpl.querySelector('.notes');
  const capT   = tpl.querySelector('.caption-title');
  const capA   = tpl.querySelector('.caption-artist');

  card.dataset.idx = idx;

  const safeTitle  = rec.title  || "Untitled";
  const safeArtist = rec.artist || "Unknown Artist";

  capT.textContent = safeTitle;
  capA.textContent = safeArtist;
  titleE.textContent  = safeTitle;
  artistE.textContent = safeArtist;
  genreE.innerHTML    = rec.genre ? `<span class="chip">${rec.genre}</span>` : "";
  if (notesE) notesE.textContent = rec.notes || "";

  // immediate placeholder; real img comes via hydrate or if already resolved
  const initial = rec.prox || rec.direct || PLACEHOLDER;
  img.alt = `${safeTitle} — ${safeArtist}`;
  img.src = initial;

  if(initial !== PLACEHOLDER){
    img.addEventListener('load', ()=> card.classList.add('loaded'), { once:true });
    img.addEventListener('error', ()=> { img.src = PLACEHOLDER; card.classList.add('loaded'); }, { once:true });
  }else{
    requestAnimationFrame(()=> card.classList.add('loaded'));
  }

  card.addEventListener('click', (e)=>{
    const isArrow = e.target.closest('.nav-arrow');
    if(isArrow) return;
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
  $('.scroller-wrap').classList.toggle('active', isScroll);
  $('.grid-wrap').classList.toggle('active', !isScroll);
  if(isScroll){ renderScroll(); toggleArrows(true); }
  else        { renderGrid();   toggleArrows(false); }
}

// ---------- 7) Behaviors ----------
function toggleArrows(show){ $$('.nav-arrow').forEach(b=> b.style.display = show ? '' : 'none'); }
function smoothScrollBy(px){ els.scroller?.scrollBy({ left: px, behavior: 'smooth' }); }
$('.nav-arrow.left') .addEventListener('click', ()=> smoothScrollBy(-Math.round(els.scroller.clientWidth*0.9)));
$('.nav-arrow.right').addEventListener('click',()=> smoothScrollBy(Math.round(els.scroller.clientWidth*0.9)));

$('#viewScroll').addEventListener('click', ()=>{
  state.view = 'scroll';
  $('#viewScroll').classList.add('active');
  $('#viewGrid').classList.remove('active');
  render();
});
$('#viewGrid').addEventListener('click', ()=>{
  state.view = 'grid';
  $('#viewGrid').classList.add('active');
  $('#viewScroll').classList.remove('active');
  render();
});

els.search.addEventListener('input', (e)=>{
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
els.sort.addEventListener('change', ()=> setSortKey(els.sort.value || 'title'));

els.shuffle.addEventListener('click', ()=>{
  for(let i=state.filtered.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [state.filtered[i], state.filtered[j]] = [state.filtered[j], state.filtered[i]];
  }
  render();
});

// ---------- 8) Stats ----------
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
function renderStatsHTML(s){
  const pill = (txt) => `<span class="chip">${txt}</span>`;
  const artists = s.topArtists.map(([name,n]) => pill(`${name} • ${n}`)).join("");
  const genres  = s.topGenres .map(([g,n])    => pill(`${g} • ${n}`)).join("");
  return `
    <div class="stat-grid">
      <div class="stat-tile"><div>Total Albums</div><div class="stat-big">${s.total}</div></div>
      <div class="stat-tile"><div>Unique Artists</div><div class="stat-big">${s.uniqArtists}</div></div>
      <div class="stat-tile"><div>Total Genres</div><div class="stat-big">${s.topGenres.length}</div></div>
    </div>

    <h3>Top Artists</h3>
    <div class="chips">${artists || '<span class="chip">No data</span>'}</div>

    <h3>Top Genres</h3>
    <div class="chips">${genres  || '<span class="chip">No data</span>'}</div>
  `;
}
function openStats(){
  const s = buildStats(state.filtered);
  els.statsBody.innerHTML = renderStatsHTML(s);
  els.statsDlg.showModal();
}
$('#statsModal .dialog-close').addEventListener('click', ()=> els.statsDlg.close());
els.statsBtn.addEventListener('click', openStats);

// ---------- 9) Kickoff ----------
loadFromSheet();
applySort();
