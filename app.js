/* -------------------------------------------
   Vinyl Collection — drop-in app.js
   Works with your published CSV sheet
   (must end in .../pub?output=csv)
-------------------------------------------- */

// 0) CONFIG
const SHEET_CSV =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?output=csv";

// header synonyms so your sheet can be flexible
const HEADER_ALIASES = {
  title:  ["title","album","record","release"],
  artist: ["artist","artists","band"],
  genre:  ["genre","genres","style","category"],
  notes:  ["notes","special notes","comment","comments","description"],
  cover:  ["album artwork","artwork","cover","cover url","image","art","art url","artwork url"]
};

// 1) DOM (exact IDs from your index.html)
const els = {
  search:       document.getElementById("search"),
  viewScroll:   document.getElementById("view-scroll"),
  viewGrid:     document.getElementById("view-grid"),
  sort:         document.getElementById("sort"),
  shuffle:      document.getElementById("shuffle"),
  scroller:     document.getElementById("scroller"),
  grid:         document.getElementById("grid"),
  scrollPrev:   document.getElementById("scrollPrev"),
  scrollNext:   document.getElementById("scrollNext"),
  statsBtn:     document.getElementById("statsBtn"),
  statsModal:   document.getElementById("statsModal"),
  statsBody:    document.getElementById("statsBody"),
  scrollView:   document.getElementById("scrollView"),
  gridView:     document.getElementById("gridView"),
  scrollerWrap: document.getElementById("scrollerWrap"),
  main:         document.querySelector("main")
};

// 2) STATE
const state = {
  all: [],
  filtered: [],
  view: "scroll",
  sortKey: "title"
};

// 3) UTILITIES
const pick = (row, synonyms) => {
  for (const key of synonyms) {
    const hit = Object.keys(row).find(h => h.trim().toLowerCase() === key);
    if (hit && String(row[hit]).trim()) return String(row[hit]).trim();
  }
  return "";
};

const looksLikeImage = u => /\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i.test(u||"");

// resize/cache via wsrv (fast, CORS-friendly)
function wsrv(url){
  if(!url) return "";
  const u = url.replace(/^https?:\/\//, "");
  return `https://wsrv.nl/?url=${encodeURIComponent("ssl:"+u)}&w=1000&h=1000&fit=cover&output=webp&q=85`;
}

// Wikipedia page → lead image (REST API)
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

// very small concurrency pool (so we don’t block the UI)
async function withConcurrency(items, limit, worker){
  const running = new Set();
  for (let i=0;i<items.length;i++){
    const p = Promise.resolve(worker(items[i], i));
    running.add(p);
    p.finally(()=>running.delete(p));
    if (running.size >= limit) await Promise.race(running);
  }
  await Promise.allSettled([...running]);
}

// 4) STATUS + SKELETONS
function showStatus(msg){
  let el = document.getElementById("status");
  if(!el){
    el = document.createElement("div");
    el.id = "status";
    el.style.cssText = "margin:16px 0;padding:12px 14px;border:1px solid var(--border);background:#0f1727;color:var(--fg);border-radius:12px;";
    els.main.prepend(el);
  }
  el.textContent = msg;
}

function skeletonCardHTML(i){
  return `
    <article class="card" data-idx="${i}">
      <div class="sleeve">
        <div class="face front">
          <div class="cover" style="width:100%;height:100%;background:linear-gradient(90deg,#0a0f20 25%,#10182e 50%,#0a0f20 75%);background-size:200% 100%;animation:sh 1.2s infinite;"></div>
        </div>
        <div class="face back"></div>
      </div>
      <div class="caption">
        <div class="caption-title">&nbsp;</div>
        <div class="caption-artist">&nbsp;</div>
      </div>
    </article>`;
}
// shimmer keyframes (inlined once)
if(!document.getElementById("shimmer-style")){
  const s = document.createElement("style");
  s.id="shimmer-style";
  s.textContent=`@keyframes sh{0%{background-position:200% 0}100%{background-position:-200% 0}}`;
  document.head.appendChild(s);
}

// 5) RENDERING
function cardHTML(rec, idx){
  const t = rec.title || "Untitled";
  const a = rec.artist || "Unknown Artist";
  const cover = rec.cover || "";
  const back = `
    <div class="meta">
      <h3 class="title">${t}</h3>
      <p class="artist">${a}</p>
      ${rec.genre ? `<p class="genre">${rec.genre}</p>` : ""}
      ${rec.notes ? `<p style="margin-top:10px;white-space:pre-wrap">${rec.notes}</p>` : ""}
    </div>`;
  return `
    <article class="card" data-idx="${idx}" role="listitem" tabindex="0">
      <div class="sleeve">
        <div class="face front">
          ${cover ? `<img class="cover" alt="${t} — ${a}" loading="lazy" decoding="async" src="${cover}">` :
                     `<div class="cover" style="width:100%;height:100%;background:linear-gradient(90deg,#0a0f20 25%,#10182e 50%,#0a0f20 75%);background-size:200% 100%;animation:sh 1.2s infinite;"></div>`}
        </div>
        <div class="face back">${back}</div>
      </div>
      <div class="caption">
        <div class="caption-title">${t}</div>
        <div class="caption-artist">${a}</div>
      </div>
    </article>`;
}

function bindCardFlips(container){
  container.addEventListener("click", (e)=>{
    const card = e.target.closest(".card");
    if(!card) return;
    card.classList.toggle("flipped");
  });
}

function renderScroll(){
  els.scroller.innerHTML = state.filtered.length
    ? state.filtered.map((r,i)=>cardHTML(r,i)).join("")
    : "";
  bindCardFlips(els.scroller);
}
function renderGrid(){
  els.grid.innerHTML = state.filtered.length
    ? state.filtered.map((r,i)=>cardHTML(r,i)).join("")
    : "";
  bindCardFlips(els.grid);
}
function applySort(){
  const k = state.sortKey;
  state.filtered.sort((a,b)=>{
    const A = (a[k]||"").toLowerCase(), B = (b[k]||"").toLowerCase();
    return A.localeCompare(B);
  });
}
function render(){
  applySort();
  if(state.view === "scroll"){
    els.scrollView.classList.add("active");
    els.gridView.classList.remove("active");
    renderScroll();
    // show arrows in scroll view only
    els.scrollPrev.style.display = "";
    els.scrollNext.style.display = "";
  }else{
    els.gridView.classList.add("active");
    els.scrollView.classList.remove("active");
    renderGrid();
    els.scrollPrev.style.display = "none";
    els.scrollNext.style.display = "none";
  }
}

// 6) LOAD SHEET → immediate skeletons → hydrate artwork in background
async function loadFromSheet(){
  showStatus("Loading Google Sheet…");
  const r = await fetch(SHEET_CSV, { cache: "no-store" });
  const text = await r.text();

  // Papa is loaded via <script> in your HTML
  const parsed = Papa.parse(text, { header:true, skipEmptyLines:true });
  const rows = parsed.data || [];

  // normalize rows
  const normalized = rows.map((row)=> {
    const title  = pick(row, HEADER_ALIASES.title);
    const artist = pick(row, HEADER_ALIASES.artist);
    const genre  = pick(row, HEADER_ALIASES.genre);
    const notes  = pick(row, HEADER_ALIASES.notes);
    const coverRaw = pick(row, HEADER_ALIASES.cover);
    let cover = "";

    if (coverRaw){
      if (looksLikeImage(coverRaw)) cover = wsrv(coverRaw);
      else if (/wikipedia\.org\/wiki\//i.test(coverRaw)) cover = ""; // resolve asynchronously
      else cover = wsrv(coverRaw); // try anyway
    }

    return { title, artist, genre, notes, coverRaw, cover };
  }).filter(r => r.title || r.artist);

  state.all = [...normalized];
  state.filtered = [...normalized];

  showStatus(`Loaded ${state.all.length} records from Google Sheet.`);
  // quick skeleton fill (so it never looks empty)
  const skeletons = Array.from({length: Math.min(6, state.all.length)}, (_,i)=>skeletonCardHTML(i)).join("");
  els.scroller.innerHTML = skeletons;
  els.grid.innerHTML     = skeletons;

  // first paint right away
  render();

  // hydrate missing Wikipedia covers in the background (concurrency 6)
  const needWiki = state.all
    .map((rec, idx) => ({ rec, idx }))
    .filter(x => !x.rec.cover && /wikipedia\.org\/wiki\//i.test(x.rec.coverRaw||""));

  await withConcurrency(needWiki, 6, async ({rec, idx})=>{
    const img = await fromWikipediaPage(rec.coverRaw);
    if (img){
      rec.cover = img;
      // live-update whichever view is mounted
      const el = document.querySelector(`.card[data-idx="${idx}"] .cover`);
      if (el){
        if (el.tagName === "IMG") el.src = img;
        else {
          const imgTag = document.createElement("img");
          imgTag.className = "cover";
          imgTag.alt = `${rec.title || "Untitled"} — ${rec.artist || "Unknown Artist"}`;
          imgTag.loading = "lazy";
          imgTag.decoding = "async";
          imgTag.src = img;
          el.replaceWith(imgTag);
        }
      }
    }
  });
}

// 7) SEARCH / SORT / VIEW / SHUFFLE
els.search.addEventListener("input", (e)=>{
  const q = e.target.value.trim().toLowerCase();
  state.filtered = state.all.filter(r=>{
    const hay = `${r.title} ${r.artist} ${r.genre} ${r.notes}`.toLowerCase();
    return hay.includes(q);
  });
  render();
});

els.sort.addEventListener("change", ()=>{
  state.sortKey = els.sort.value || "title";
  render();
});

els.shuffle.addEventListener("click", ()=>{
  for (let i=state.filtered.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [state.filtered[i], state.filtered[j]] = [state.filtered[j], state.filtered[i]];
  }
  render();
});

els.viewScroll.addEventListener("click", ()=>{
  els.viewScroll.classList.add("active");
  els.viewGrid.classList.remove("active");
  state.view = "scroll";
  render();
});

els.viewGrid.addEventListener("click", ()=>{
  els.viewGrid.classList.add("active");
  els.viewScroll.classList.remove("active");
  state.view = "grid";
  render();
});

els.scrollPrev.addEventListener("click", ()=> {
  els.scroller.scrollBy({ left: -Math.round(els.scroller.clientWidth*0.9), behavior:"smooth" });
});
els.scrollNext.addEventListener("click", ()=> {
  els.scroller.scrollBy({ left:  Math.round(els.scroller.clientWidth*0.9), behavior:"smooth" });
});

// 8) STATS (artists styled like genre chips)
function buildStats(recs){
  const artistMap = new Map();
  const genreMap  = new Map();
  recs.forEach(r=>{
    if(r.artist) artistMap.set(r.artist, (artistMap.get(r.artist)||0)+1);
    if(r.genre){
      String(r.genre)
        .split(/[\/,&]| and /i)
        .map(s=>s.trim()).filter(Boolean)
        .forEach(g=> genreMap.set(g, (genreMap.get(g)||0)+1));
    }
  });
  const topArtists = [...artistMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12);
  const topGenres  = [...genreMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12);
  return { total: recs.length, uniqArtists: artistMap.size, topArtists, topGenres };
}

function openStats(){
  const s = buildStats(state.filtered);
  const body = els.statsBody;
  body.innerHTML = "";

  const grid = document.createElement("div");
  grid.className = "stat-grid";
  grid.innerHTML = `
    <div class="stat-tile"><div>Total Albums</div><div class="stat-big">${s.total}</div></div>
    <div class="stat-tile"><div>Unique Artists</div><div class="stat-big">${s.uniqArtists}</div></div>
    <div class="stat-tile"><div>Total Genres</div><div class="stat-big">${s.topGenres.length}</div></div>`;
  body.appendChild(grid);

  if (s.topArtists.length){
    const h = document.createElement("h3"); h.textContent = "Top Artists"; body.appendChild(h);
    const chips = document.createElement("div"); chips.className = "chips";
    s.topArtists.forEach(([name,count])=>{
      const span = document.createElement("span");
      span.className = "chip";
      span.textContent = `${name} • ${count}`;
      chips.appendChild(span);
    });
    body.appendChild(chips);
  }

  if (s.topGenres.length){
    const h = document.createElement("h3"); h.textContent = "Top Genres"; body.appendChild(h);
    const chips = document.createElement("div"); chips.className = "chips";
    s.topGenres.forEach(([g,count])=>{
      const span = document.createElement("span");
      span.className = "chip";
      span.textContent = `${g} • ${count}`;
      chips.appendChild(span);
    });
    body.appendChild(chips);
  }

  els.statsModal.showModal();
}
els.statsBtn.addEventListener("click", openStats);

// 9) KICK OFF
loadFromSheet();
