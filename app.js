/* -----------------------------------
   Vinyl Collection — app.js (resilient art + sticky UI)
   Sheet CSV:
   https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?output=csv
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

const el = {
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

// Simple cache for resolved cover images to avoid repeat lookups
const artCache = new Map(); // key: "artist|title" -> url or "none"

// 3) CSV helpers
function pick(obj, names){
  const keys = Object.keys(obj);
  for (const n of names){
    const k = keys.find(h => h?.trim?.().toLowerCase() === n);
    if (k && String(obj[k]).trim()) return String(obj[k]).trim();
  }
  return "";
}

// PapaParse (included via <script> in index.html)
function parseCSV(text){
  return Papa.parse(text, {header:true, skipEmptyLines:true}).data;
}

// 4) Artwork helpers
function looksLikeImage(u){ return /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(u||""); }

function wsrv(url){
  if(!url) return "";
  const cleaned = url.replace(/^https?:\/\//,"");
  return `https://wsrv.nl/?url=${encodeURIComponent("ssl:"+cleaned)}&w=1000&h=1000&fit=cover&output=webp&q=85`;
}

// Wikipedia page → lead image
async function wikiSummaryImage(pageTitle){
  try{
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`);
    if(!r.ok) return "";
    const j = await r.json();
    const src = j?.originalimage?.source || j?.thumbnail?.source;
    return src ? wsrv(src) : "";
  }catch{ return ""; }
}

// Wikipedia search → best page image (CORS-safe via origin=*)
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

// Try to resolve artwork using (1) given URL, (2) wiki page, (3) wiki search
async function resolveCover({ coverIn, artist, title }){
  const key = `${(artist||"").toLowerCase()}|${(title||"").toLowerCase()}`;
  if (artCache.has(key)) return artCache.get(key) || "";

  let cover = "";
  if (coverIn){
    if (looksLikeImage(coverIn)) cover = wsrv(coverIn);
    else if (/wikipedia\.org\/wiki\//i.test(coverIn)){
      const page = decodeURIComponent(coverIn.split("/wiki/")[1]||"").split(/[?#]/)[0];
      cover = await wikiSummaryImage(page);
    }
  }
  if (!cover){
    cover = await wikiSearchCover(artist||"", title||"");
  }

  artCache.set(key, cover || "none");
  return cover || "";
}

// 5) Load data
async function loadFromSheet(){
  try{
    const res  = await fetch(SHEET_CSV, {cache:"no-store"});
    const text = await res.text();

    if (text.trim().startsWith("<")){
      console.warn("Sheet link is not CSV. Make sure it ends with output=csv.");
      return;
    }

    const rows = parseCSV(text);
    const list = [];

    for (const r of rows){
      const title   = pick(r, HEADER_ALIASES.title);
      const artist  = pick(r, HEADER_ALIASES.artist);
      const genre   = pick(r, HEADER_ALIASES.genre);  // add a "Genre" column in your sheet to populate this
      const notes   = pick(r, HEADER_ALIASES.notes);
      const coverIn = pick(r, HEADER_ALIASES.cover);
      if(!title && !artist) continue;

      const cover = await resolveCover({ coverIn, artist, title });
      list.push({ title, artist, genre, notes, cover });
    }

    state.all = list;
    state.filtered = [...list];
    applySort();
    render();
  }catch(e){
    console.error(e);
  }
}

// 6) Card creation (template-free)
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
  if (rec.cover) img.src = rec.cover;

  // If the given image fails, try wiki search once
  img.addEventListener("error", async () => {
    if (img.dataset.retry === "1") return; // only once
    img.dataset.retry = "1";
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

  // Flip
  article.addEventListener("click", ()=> article.classList.toggle("flipped"));

  return article;
}

function renderScroll(){
  if (!el.scroller) return;
  el.scroller.innerHTML = "";
  const frag = document.createDocumentFragment();
  state.filtered.forEach(rec => frag.appendChild(createCard(rec)));
  el.scroller.appendChild(frag);
}

function renderGrid(){
  if (!el.grid) return;
  el.grid.innerHTML = "";
  const frag = document.createDocumentFragment();
  state.filtered.forEach(rec => frag.appendChild(createCard(rec)));
  el.grid.appendChild(frag);
}

function render(){
  const scrollView = $("#scrollView");
  const gridView   = $("#gridView");

  if (state.view === "scroll"){
    scrollView?.classList.add("active");
    gridView?.classList.remove("active");
    renderScroll();
    toggleArrows(true);
  } else {
    gridView?.classList.add("active");
    scrollView?.classList.remove("active");
    renderGrid();
    toggleArrows(false);
  }
}

// 7) Interactions
function toggleArrows(show){
  if (el.prev) el.prev.style.display = show ? "" : "none";
  if (el.next) el.next.style.display = show ? "" : "none";
}
function smoothScrollBy(px){
  el.scroller?.scrollBy({left:px, behavior:"smooth"});
}

el.prev?.addEventListener("click", ()=> smoothScrollBy(-Math.round(el.scroller.clientWidth*0.9)));
el.next?.addEventListener("click", ()=> smoothScrollBy( Math.round(el.scroller.clientWidth*0.9)));

el.viewScroll?.addEventListener("click", ()=>{
  state.view = "scroll";
  el.viewScroll.classList.add("active");
  el.viewGrid?.classList.remove("active");
  render();
});
el.viewGrid?.addEventListener("click", ()=>{
  state.view = "grid";
  el.viewGrid.classList.add("active");
  el.viewScroll?.classList.remove("active");
  render();
});

el.search?.addEventListener("input", (e)=>{
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
el.sort?.addEventListener("change", ()=> setSortKey(el.sort.value || "title"));

el.shuffle?.addEventListener("click", ()=>{
  for (let i=state.filtered.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [state.filtered[i], state.filtered[j]] = [state.filtered[j], state.filtered[i]];
  }
  render();
});

// 8) Stats
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

function ensureStatsCloseX(){
  if (!el.statsModal) return;
  const card = el.statsModal.querySelector(".stats-card");
  if (!card) return;
  if (card.querySelector(".stats-close")) return; // already there
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "stats-close";
  btn.setAttribute("aria-label","Close");
  btn.textContent = "×";
  btn.addEventListener("click", ()=> el.statsModal.close());
  card.prepend(btn);
}

function openStats(){
  if (!el.statsBody) return;
  const s = buildStats(state.filtered);
  el.statsBody.innerHTML = "";

  const grid = document.createElement("div");
  grid.className = "stat-grid";
  grid.innerHTML = `
    <div class="stat-tile"><div>Total Albums</div><div class="stat-big">${s.total}</div></div>
    <div class="stat-tile"><div>Unique Artists</div><div class="stat-big">${s.uniqArtists}</div></div>
    <div class="stat-tile"><div>Total Genres</div><div class="stat-big">${s.topGenres.length}</div></div>
  `;
  el.statsBody.appendChild(grid);

  if (s.topArtists.length){
    const h = document.createElement("h3"); h.textContent = "Top Artists"; el.statsBody.appendChild(h);
    const chips = document.createElement("div"); chips.className = "chips";
    s.topArtists.forEach(([name,n])=>{
      const c=document.createElement("span");
      c.className="chip";
      c.textContent=`${name} • ${n}`;
      chips.appendChild(c);
    });
    el.statsBody.appendChild(chips);
  }

  if (s.topGenres.length){
    const h = document.createElement("h3"); h.textContent = "Top Genres"; el.statsBody.appendChild(h);
    const chips = document.createElement("div"); chips.className = "chips";
    s.topGenres.forEach(([g,n])=>{
      const c=document.createElement("span");
      c.className="chip";
      c.textContent=`${g} • ${n}`;
      chips.appendChild(c);
    });
    el.statsBody.appendChild(chips);
  } else {
    const p = document.createElement("p");
    p.textContent = 'No genres yet. Add a "Genre" column in your Google Sheet to populate genres and stats.';
    el.statsBody.appendChild(p);
  }

  ensureStatsCloseX();
  el.statsModal?.showModal();
}
el.statsBtn?.addEventListener("click", openStats);

// 9) Kickoff
loadFromSheet();
