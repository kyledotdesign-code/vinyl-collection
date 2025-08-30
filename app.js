/* -----------------------------------
   Vinyl Collection — TURBO STATIC v3.2
   - No sentinel (no blank tile). Tail observer instead.
   - White arrows handled by CSS (see below).
   - Lazy low→high images + Wikipedia on view
   - Solid placeholder instead of broken icons
----------------------------------- */

// 0) Config
const SHEET_CSV =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?output=csv";

const HEADER_ALIASES = {
  title:  ["title","album","record","release"],
  artist: ["artist","artists","band"],
  genre:  ["genre","genres","style","category"],
  notes:  ["notes","special notes","comment","comments","description"],
  cover:  ["album artwork","artwork","cover","cover url","image","art","art url","artwork url"]
};

// 1×1 transparent pixel so browsers never show a broken icon
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

// 1) Elements
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];

const ui = {
  search:     $("#search"),
  viewScroll: $("#view-scroll"),
  viewGrid:   $("#view-grid"),
  sort:       $("#sort"),
  shuffle:    $("#shuffle"),
  statsBtn:   $("#statsBtn"),
  scroller:   $("#scroller"),
  grid:       $("#grid"),
  prev:       $("#scrollPrev"),
  next:       $("#scrollNext"),
  statsModal: $("#statsModal"),
  statsBody:  $("#statsBody"),
};

// 2) State
const state = {
  all: [],
  filtered: [],
  view: "scroll",
  sortKey: "title",
  batchSize: 12,
  renderedCount: 0,
};

// 3) CSV parsing
function pick(obj, names){
  const keys = Object.keys(obj || {});
  for (const n of names){
    const k = keys.find(h => h?.trim?.().toLowerCase() === n);
    if (k && String(obj[k]).trim()) return String(obj[k]).trim();
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

// 4) Images & caching helpers
function looksLikeImage(u){ return /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(u||""); }
function wsrv(url, w=800){
  if(!url) return "";
  const cleaned = url.replace(/^https?:\/\//,"");
  return `https://wsrv.nl/?url=${encodeURIComponent("ssl:"+cleaned)}&w=${w}&h=${w}&fit=cover&output=webp&q=82`;
}
function placeholderDataURI(title, artist){
  const t = (title||"").trim();
  const a = (artist||"").trim();
  const initials = (t || a || "♪")
    .split(/\s+/).slice(0,2).map(s=>s[0]).join("").toUpperCase() || "♪";
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="820" height="820">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#141b28"/><stop offset="1" stop-color="#0c1220"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="410" cy="410" r="320" fill="#0e172b" opacity="0.65"/>
    <text x="50%" y="55%" text-anchor="middle" font-family="Inter,system-ui,sans-serif"
          font-weight="800" font-size="180" fill="#ffffff" opacity=".85">${initials}</text>
  </svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

// LocalStorage: sheet
const LS_SHEET = "vinylSheetV2";
function cacheSetSheet(raw){ try{ localStorage.setItem(LS_SHEET, raw); }catch{} }
function cacheGetSheet(){ try{ return localStorage.getItem(LS_SHEET) || ""; }catch{ return ""; } }

// Wikipedia image cache
const wikiMem = new Map();
function wikiKey(t){ return "wiki:"+t; }
function wikiGetLS(t){ try{ const v = localStorage.getItem(wikiKey(t)); return v ? JSON.parse(v) : null; }catch{ return null; } }
function wikiSetLS(t,val){ try{ localStorage.setItem(wikiKey(t), JSON.stringify(val)); }catch{} }

async function fetchWikiImage(title){
  if (!title) return {low:"",high:""};
  if (wikiMem.has(title)) return wikiMem.get(title);
  const cached = wikiGetLS(title);
  if (cached){ wikiMem.set(title, cached); return cached; }
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  try{
    const r = await fetch(url);
    if (!r.ok) throw 0;
    const j = await r.json();
    const src = j?.originalimage?.source || j?.thumbnail?.source || "";
    const val = src ? { low: wsrv(src,240), high: wsrv(src,820) } : {low:"",high:""};
    wikiSetLS(title,val);
    wikiMem.set(title,val);
    return val;
  }catch{
    const val = {low:"",high:""};
    wikiMem.set(title,val);
    return val;
  }
}

// 5) Load sheet (SWR)
async function loadSheet(){
  const cached = cacheGetSheet();
  if (cached){
    try { hydrateFromCSV(cached); renderFresh(); requestIdleCallback?.(()=>updateStats()); } catch {}
  }
  try {
    const res  = await fetch(SHEET_CSV, { cache: "no-store" });
    const text = await res.text();
    if (!text.trim().startsWith("<") && text !== cached){
      cacheSetSheet(text);
      hydrateFromCSV(text);
      renderFresh();
      requestIdleCallback?.(()=>updateStats());
    }
  } catch {}
}

function hydrateFromCSV(text){
  const { data: rows } = parseCSV(text);
  const list = rows.map(r => {
    const title  = pick(r, HEADER_ALIASES.title);
    const artist = pick(r, HEADER_ALIASES.artist);
    const genre  = pick(r, HEADER_ALIASES.genre);
    const notes  = pick(r, HEADER_ALIASES.notes);
    const coverHint = pick(r, HEADER_ALIASES.cover);

    let low="", high="", wiki="";
    if (looksLikeImage(coverHint)){
      low  = wsrv(coverHint, 240);
      high = wsrv(coverHint, 820);
    } else if (/wikipedia\.org\/wiki\//i.test(coverHint)){
      const m = coverHint.match(/\/wiki\/([^?#]+)/i);
      wiki = m ? decodeURIComponent(m[1]).replace(/_/g," ") : "";
    }

    return { title, artist, genre, notes, low, high, wiki };
  }).filter(x => x.title || x.artist);

  state.all = list;
  state.filtered = [...list];
  applySort();
}

// 6) Image lazying (low→high + on-view Wikipedia)
let imgIO;
function ensureImgObserver(root){
  if (imgIO) imgIO.disconnect();
  imgIO = new IntersectionObserver((entries)=>{
    entries.forEach(async entry=>{
      if (!entry.isIntersecting) return;
      const img = entry.target;

      // Wikipedia resolve on demand
      if (!img.dataset.srcLow && !img.dataset.srcHigh && img.dataset.wiki && !img.dataset.fetching){
        img.dataset.fetching = "1";
        const res = await fetchWikiImage(img.dataset.wiki);
        if (res.low)  img.dataset.srcLow  = res.low;
        if (res.high) img.dataset.srcHigh = res.high;
      }

      const low  = img.dataset.srcLow;
      const high = img.dataset.srcHigh;

      // show low first
      if (low && !img.dataset.didLow){
        img.src = low;
        img.dataset.didLow = "1";
        img.onload = ()=> img.classList.remove("skeleton");
      }

      // upgrade to high
      if (high && !img.dataset.didHigh){
        const swap = new Image();
        swap.decoding = "async";
        swap.onload = ()=>{
          img.src = high;
          img.dataset.didHigh = "1";
        };
        swap.onerror = ()=>{};
        swap.src = high;
      }

      imgIO.unobserve(img);
    });
  }, {
    root: state.view === "scroll" ? ui.scroller : null,
    rootMargin: "800px 0px",
    threshold: 0.01
  });

  (root || document).querySelectorAll("img.cover").forEach(img => imgIO.observe(img));
}

// 7) Rendering
function createCard(rec, index){
  const title  = rec.title  || "Untitled";
  const artist = rec.artist || "Unknown Artist";

  const article = document.createElement("article");
  article.className = "card";
  article.setAttribute("role","listitem");

  const sleeve = document.createElement("div");
  sleeve.className = "sleeve";
  sleeve.setAttribute("aria-live","polite");

  // FRONT
  const faceFront = document.createElement("div");
  faceFront.className = "face front";

  const img = document.createElement("img");
  img.className = "cover skeleton";
  img.loading = "lazy";
  img.decoding = "async";
  img.fetchPriority = index < 6 ? "high" : "low";
  img.referrerPolicy = "no-referrer";
  img.alt = `${title} — ${artist}`;
  img.src = BLANK; // never show broken icon

  if (rec.low)   img.dataset.srcLow = rec.low;
  if (rec.high)  img.dataset.srcHigh = rec.high;
  if (!rec.low && !rec.high && rec.wiki) img.dataset.wiki = rec.wiki;

  if (!rec.low && !rec.high && !rec.wiki){
    img.src = placeholderDataURI(title, artist);
    img.classList.remove("skeleton");
  }
  img.addEventListener("error", ()=>{
    img.src = placeholderDataURI(title, artist);
    img.classList.remove("skeleton");
  });

  faceFront.appendChild(img);

  // BACK
  const faceBack = document.createElement("div");
  faceBack.className = "face back";

  const meta = document.createElement("div");
  meta.className = "meta";

  const h3 = document.createElement("h3");
  h3.className = "title";
  h3.textContent = title;

  const pArtist = document.createElement("p");
  pArtist.className = "artist";
  pArtist.textContent = artist;

  const pGenre = document.createElement("p");
  pGenre.className = "genre";
  pGenre.textContent = rec.genre ? `Genre: ${rec.genre}` : "";

  meta.appendChild(h3);
  meta.appendChild(pArtist);
  meta.appendChild(pGenre);

  if (rec.notes){
    const pNotes = document.createElement("p");
    pNotes.className = "notes";
    pNotes.textContent = rec.notes;
    meta.appendChild(pNotes);
  }

  faceBack.appendChild(meta);
  sleeve.appendChild(faceFront);
  sleeve.appendChild(faceBack);

  // CAPTION
  const caption = document.createElement("div");
  caption.className = "caption";
  const capT = document.createElement("div");
  capT.className = "caption-title";
  capT.textContent = title;
  const capA = document.createElement("div");
  capA.className = "caption-artist";
  capA.textContent = artist;
  caption.appendChild(capT); caption.appendChild(capA);

  article.appendChild(sleeve);
  article.appendChild(caption);

  // Flip on click
  article.addEventListener("click", ()=> article.classList.toggle("flipped"));

  return article;
}

function clearViews(){
  ui.scroller.innerHTML = "";
  ui.grid.innerHTML = "";
  state.renderedCount = 0;
}

function renderFresh(){
  clearViews();
  if (state.view === "scroll"){
    $("#scrollView").classList.add("active");
    $("#gridView").classList.remove("active");
    toggleArrows(true);
    renderBatch(ui.scroller);
    observeTail(ui.scroller);
    ensureImgObserver(ui.scroller);
  } else {
    $("#gridView").classList.add("active");
    $("#scrollView").classList.remove("active");
    toggleArrows(false);
    renderBatch(ui.grid);
    observeTail(ui.grid);
    ensureImgObserver(ui.grid);
  }
}

function renderBatch(container){
  const start = state.renderedCount;
  const end = Math.min(start + state.batchSize, state.filtered.length);
  if (start >= end) return;

  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++){
    frag.appendChild(createCard(state.filtered[i], i));
  }
  container.appendChild(frag);

  ensureImgObserver(container);
  state.renderedCount = end;
}

// Tail observer (no sentinel → no empty column)
let tailIO;
function observeTail(container){
  if (tailIO) tailIO.disconnect();

  tailIO = new IntersectionObserver((entries)=>{
    entries.forEach(e=>{
      if (!e.isIntersecting) return;
      // unobserve current tail, render more, observe new tail
      tailIO.unobserve(e.target);
      renderBatch(container);
      const last = container.querySelector(".card:last-child");
      if (last) tailIO.observe(last);
    });
  }, { root: state.view === "scroll" ? ui.scroller : null, rootMargin: "800px" });

  const last = container.querySelector(".card:last-child");
  if (last) tailIO.observe(last);
}

// 8) UI
function toggleArrows(show){
  if (ui.prev) ui.prev.style.display = show ? "" : "none";
  if (ui.next) ui.next.style.display = show ? "" : "none";
}
function smoothScrollBy(px){
  ui.scroller?.scrollBy({left:px, behavior:"smooth"});
}
ui.prev?.addEventListener("click", ()=> smoothScrollBy(-Math.round(ui.scroller.clientWidth*0.9)));
ui.next?.addEventListener("click", ()=> smoothScrollBy( Math.round(ui.scroller.clientWidth*0.9)));

ui.viewScroll?.addEventListener("click", ()=>{
  state.view = "scroll";
  ui.viewScroll.classList.add("active");
  ui.viewGrid?.classList.remove("active");
  renderFresh();
});
ui.viewGrid?.addEventListener("click", ()=>{
  state.view = "grid";
  ui.viewGrid.classList.add("active");
  ui.viewScroll?.classList.remove("active");
  renderFresh();
});

ui.search?.addEventListener("input", (e)=>{
  const q = e.target.value.trim().toLowerCase();
  state.filtered = state.all.filter(r=>{
    const hay = `${r.title} ${r.artist} ${r.genre} ${r.notes}`.toLowerCase();
    return hay.includes(q);
  });
  applySort();
  renderFresh();
});

function setSortKey(k){
  state.sortKey = k;
  applySort(); renderFresh();
}
function applySort(){
  const k = state.sortKey;
  state.filtered.sort((a,b)=>{
    const A = (a[k]||"").toLowerCase();
    const B = (b[k]||"").toLowerCase();
    return A.localeCompare(B);
  });
}
ui.sort?.addEventListener("change", ()=> setSortKey(ui.sort.value || "title"));

ui.shuffle?.addEventListener("click", ()=>{
  for (let i=state.filtered.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [state.filtered[i], state.filtered[j]] = [state.filtered[j], state.filtered[i]];
  }
  renderFresh();
});

// 9) Stats
function buildStats(recs){
  const total = recs.length;
  const artistMap = new Map();
  const genreMap  = new Map();
  for (const r of recs){
    if (r.artist) artistMap.set(r.artist, (artistMap.get(r.artist)||0)+1);
    if (r.genre){
      String(r.genre)
        .split(/[\/,&]| and /i)
        .map(s=>s.trim())
        .filter(Boolean)
        .forEach(g => genreMap.set(g, (genreMap.get(g)||0)+1));
    }
  }
  const topArtists = [...artistMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12);
  const topGenres  = [...genreMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12);
  return { total, uniqArtists: artistMap.size, topArtists, topGenres };
}
function updateStats(){
  if (!ui.statsBody) return;
  const s = buildStats(state.filtered);
  ui.statsBody.innerHTML = "";

  const grid = document.createElement("div");
  grid.className = "stat-grid";
  grid.innerHTML = `
    <div class="stat-tile"><div>Total Albums</div><div class="stat-big">${s.total}</div></div>
    <div class="stat-tile"><div>Unique Artists</div><div class="stat-big">${s.uniqArtists}</div></div>
    <div class="stat-tile"><div>Total Genres</div><div class="stat-big">${s.topGenres.length}</div></div>
  `;
  ui.statsBody.appendChild(grid);

  if (s.topArtists.length){
    const h = document.createElement("h3"); h.textContent = "Top Artists"; ui.statsBody.appendChild(h);
    const chips = document.createElement("div"); chips.className = "chips";
    s.topArtists.forEach(([name,n])=>{
      const c=document.createElement("span");
      c.className="chip";
      c.textContent=`${name} • ${n}`;
      chips.appendChild(c);
    });
    ui.statsBody.appendChild(chips);
  }

  if (s.topGenres.length){
    const h = document.createElement("h3"); h.textContent = "Top Genres"; ui.statsBody.appendChild(h);
    const chips = document.createElement("div"); chips.className = "chips";
    s.topGenres.forEach(([g,n])=>{
      const c=document.createElement("span");
      c.className="chip";
      c.textContent=`${g} • ${n}`;
      chips.appendChild(c);
    });
    ui.statsBody.appendChild(chips);
  }
}
ui.statsBtn?.addEventListener("click", ()=>{
  updateStats();
  ui.statsModal?.showModal();
});
ui.statsModal?.querySelector(".stats-close")?.addEventListener("click", ()=> ui.statsModal.close());

// 10) Kickoff
loadSheet();
