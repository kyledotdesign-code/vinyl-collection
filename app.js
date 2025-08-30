/* -----------------------------------
   Vinyl Collection — FAST app.js
   Speed tricks:
   - Instant render from CSV
   - Lazy cover lookups via IntersectionObserver
   - Concurrency limit so the browser isn't flooded
   - localStorage cache for covers (persists across visits)
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
};

// localStorage cache for covers
const LS_KEY = "vinylArtCacheV1";
let artCache = {};
try { artCache = JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { artCache = {}; }
function cacheGet(key){ return artCache[key]; }
function cacheSet(key, url){
  artCache[key] = url || "none";
  try { localStorage.setItem(LS_KEY, JSON.stringify(artCache)); } catch {}
}

// 3) Helpers
function pick(obj, names){
  const keys = Object.keys(obj);
  for (const n of names){
    const k = keys.find(h => h?.trim?.().toLowerCase() === n);
    if (k && String(obj[k]).trim()) return String(obj[k]).trim();
  }
  return "";
}
function looksLikeImage(u){ return /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(u||""); }
function wsrv(url){
  if(!url) return "";
  const cleaned = url.replace(/^https?:\/\//,"");
  return `https://wsrv.nl/?url=${encodeURIComponent("ssl:"+cleaned)}&w=1000&h=1000&fit=cover&output=webp&q=85`;
}

// Wikipedia summary image for a page title
async function wikiSummaryImage(pageTitle){
  try{
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`);
    if(!r.ok) return "";
    const j = await r.json();
    const src = j?.originalimage?.source || j?.thumbnail?.source;
    return src ? wsrv(src) : "";
  }catch{ return ""; }
}

// Wikipedia search best image
async function wikiSearchCover(artist, title){
  const q = `${title} ${artist} album`;
  try{
    const url = `https://en.wikipedia.org/w/api.php?origin=*&action=query&format=json&prop=pageimages&piprop=original|thumbnail&pithumbsize=1000&generator=search&gsrlimit=1&gsrsearch=${encodeURIComponent(q)}`;
    const res = await fetch(url, { cache: "no-store" });
    if(!res.ok) return "";
    const j = await res.json();
    const pages = j?.query?.pages;
    if(!pages) return "";
    const page = Object.values(pages)[0];
    const src = page?.original?.source || page?.thumbnail?.source;
    return src ? wsrv(src) : "";
  }catch{ return ""; }
}

// Resolve cover lazily (with cache)
async function resolveCoverLazy({ coverHint, artist, title }){
  const key = `${(artist||"").toLowerCase()}|${(title||"").toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached && cached !== "none") return cached;
  if (cached === "none") return ""; // known miss

  let cover = "";

  // If the hint is a direct image URL, use it immediately
  if (coverHint && looksLikeImage(coverHint)) {
    cover = wsrv(coverHint);
  } else if (coverHint && /wikipedia\.org\/wiki\//i.test(coverHint)) {
    // If hint is a wiki page, grab that page's lead image
    const page = decodeURIComponent(coverHint.split("/wiki/")[1]||"").split(/[?#]/)[0];
    cover = await wikiSummaryImage(page);
  }

  // If still nothing, try Wikipedia search
  if (!cover) cover = await wikiSearchCover(artist||"", title||"");

  cacheSet(key, cover || "none");
  return cover || "";
}

// Tiny concurrency limiter for image lookups
const MAX_CONCURRENCY = 6;
let active = 0;
const q = [];
function enqueue(task){
  q.push(task);
  drain();
}
function drain(){
  while (active < MAX_CONCURRENCY && q.length){
    const t = q.shift();
    active++;
    t().finally(()=>{ active--; drain(); });
  }
}

// 4) Load the sheet and render immediately
async function loadFromSheet(){
  const res  = await fetch(SHEET_CSV, { cache: "no-store" });
  const text = await res.text();
  if (text.trim().startsWith("<")) {
    console.warn("Sheet link is not CSV. Ensure it ends with output=csv.");
    return;
  }
  const rows = Papa.parse(text, {header:true, skipEmptyLines:true}).data;

  const list = rows.map(r => {
    const title  = pick(r, HEADER_ALIASES.title);
    const artist = pick(r, HEADER_ALIASES.artist);
    const genre  = pick(r, HEADER_ALIASES.genre);
    const notes  = pick(r, HEADER_ALIASES.notes);
    const coverHint = pick(r, HEADER_ALIASES.cover);
    const immediate = (coverHint && looksLikeImage(coverHint)) ? wsrv(coverHint) : ""; // immediate only for direct images
    return { title, artist, genre, notes, coverHint, cover: immediate };
  }).filter(x => x.title || x.artist);

  state.all = list;
  state.filtered = [...list];
  applySort();
  render();

  // Kick a quick pre-warm for the first few items
  requestIdleCallback?.(()=>prewarmCovers(8));
}

// Prewarm a handful of covers immediately (first N cards)
function prewarmCovers(n=8){
  const imgs = $$(".cover").slice(0, n);
  imgs.forEach(img => ensureCover(img));
}

// 5) Card creation (no templates = fast)
function createCard(rec){
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
  img.className = "cover";
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  img.alt = `${title} — ${artist}`;

  // If we already have an immediate cover, set it; else mark for lazy resolve
  if (rec.cover) {
    img.src = rec.cover;
  } else {
    img.dataset.artist = artist;
    img.dataset.title  = title;
    img.dataset.hint   = rec.coverHint || "";
  }

  // One-time fallback if image fails
  img.addEventListener("error", async () => {
    if (img.dataset.retry === "1") return;
    img.dataset.retry = "1";
    // Try wiki search as a last resort
    const fallback = await wikiSearchCover(artist, title);
    if (fallback) img.src = fallback;
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

  // CAPTION (outside the sleeve so it never covers art)
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

function renderScroll(){
  ui.scroller.innerHTML = "";
  const frag = document.createDocumentFragment();
  state.filtered.forEach(rec => frag.appendChild(createCard(rec)));
  ui.scroller.appendChild(frag);
  initArtObserver();
}

function renderGrid(){
  ui.grid.innerHTML = "";
  const frag = document.createDocumentFragment();
  state.filtered.forEach(rec => frag.appendChild(createCard(rec)));
  ui.grid.appendChild(frag);
  initArtObserver();
}

function render(){
  const scrollView = $("#scrollView");
  const gridView   = $("#gridView");
  if (state.view === "scroll"){
    scrollView.classList.add("active");
    gridView.classList.remove("active");
    renderScroll();
    toggleArrows(true);
  } else {
    gridView.classList.add("active");
    scrollView.classList.remove("active");
    renderGrid();
    toggleArrows(false);
  }
}

// 6) Lazy artwork via IntersectionObserver + concurrency
let io;
function initArtObserver(){
  if (io) io.disconnect();

  io = new IntersectionObserver((entries)=>{
    entries.forEach(entry=>{
      if (!entry.isIntersecting) return;
      const img = entry.target;
      io.unobserve(img);
      ensureCover(img);
    });
  }, { root: state.view === "scroll" ? ui.scroller : null, rootMargin: "200px", threshold: 0.01 });

  $$(".cover").forEach(img=>{
    if (!img.getAttribute("src")) io.observe(img);
  });
}

function ensureCover(img){
  const artist = img.dataset.artist;
  const title  = img.dataset.title;
  const hint   = img.dataset.hint;

  if (!artist && !title) return; // already has src or not enough info

  // Use cache immediately if available
  const key = `${(artist||"").toLowerCase()}|${(title||"").toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached && cached !== "none") {
    img.src = cached;
    return;
  }

  enqueue(async () => {
    const url = await resolveCoverLazy({ coverHint: hint, artist, title });
    if (url) img.src = url;
  });
}

// 7) UI
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
  render();
});
ui.viewGrid?.addEventListener("click", ()=>{
  state.view = "grid";
  ui.viewGrid.classList.add("active");
  ui.viewScroll?.classList.remove("active");
  render();
});

ui.search?.addEventListener("input", (e)=>{
  const q = e.target.value.trim().toLowerCase();
  state.filtered = state.all.filter(r=>{
    const hay = `${r.title} ${r.artist} ${r.genre} ${r.notes}`.toLowerCase();
    return hay.includes(q);
  });
  applySort();
  render();
});

function setSortKey(k){
  state.sortKey = k;
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
ui.sort?.addEventListener("change", ()=> setSortKey(ui.sort.value || "title"));

ui.shuffle?.addEventListener("click", ()=>{
  for (let i=state.filtered.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [state.filtered[i], state.filtered[j]] = [state.filtered[j], state.filtered[i]];
  }
  render();
});

// Stats
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

function openStats(){
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

  ui.statsModal?.showModal();
}
ui.statsBtn?.addEventListener("click", openStats);
ui.statsModal?.querySelector(".stats-close")?.addEventListener("click", ()=> ui.statsModal.close());

// 8) Kickoff
loadFromSheet();
