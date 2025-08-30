/* Vinyl Collection — app.js (drop-in)
   Uses your Google Sheet:
   https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?output=csv
*/

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

// ---- 1) Element wiring ----
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];

const els = {
  search: $('#search') || $('input[placeholder="Search"]'),
  viewScroll: $('#viewScroll') || $$('button,.seg-btn').find(b=>/view:\s*scroll/i.test(b?.textContent||'')),
  viewGrid:   $('#viewGrid')   || $$('button,.seg-btn').find(b=>/view:\s*grid/i.test(b?.textContent||'')),
  sort: $('#sortSelect') || $$('select,button').find(x=>/sort/i.test(x?.textContent||'')),
  shuffle: $('#btnShuffle') || $$('button').find(b=>/shuffle/i.test(b?.textContent||'')),
  stats: $('#btnStats') || $$('button').find(b=>/stats/i.test(b?.textContent||'')),
  googleSheet: $('#btnSheet') || $$('a,button').find(x=>/google\s*sheet/i.test(x?.textContent||'')),
  main: $('main') || document.body,
  scroller: $('.scroller'),
  grid: $('.grid'),
  leftArrow:  $('.nav-arrow.left'),
  rightArrow: $('.nav-arrow.right'),
  statsModal: $('#statsModal'),
  statsBody:  $('#statsBody'),
};

// Create minimal containers if missing
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
    els.scroller  = $('#scroller', wrap);
    els.leftArrow = $('.nav-arrow.left', wrap);
    els.rightArrow= $('.nav-arrow.right', wrap);
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
    els.statsBody  = $('#statsBody', d);
    $('#closeStats', d).addEventListener('click', ()=> d.close());
  }
})();

// ---- 2) State ----
const state = {
  all: [],
  filtered: [],
  view: 'scroll',   // 'scroll' | 'grid'
  sortKey: 'title', // 'title' | 'artist'
};

// ---- 3) CSV utils ----
function pick(obj, synonyms){
  for(const key of synonyms){
    const hit = Object.keys(obj).find(h => h.trim().toLowerCase() === key);
    if(hit && String(obj[hit]).trim()) return String(obj[hit]).trim();
  }
  return "";
}

function parseCSV(text){
  const rows=[]; let cur=['']; let i=0, inQ=false;
  for(; i<text.length; i++){
    const c=text[i];
    if(c==='"'){ if(inQ && text[i+1]==='"'){ cur[cur.length-1]+='"'; i++; } else inQ=!inQ; }
    else if(c===',' && !inQ){ cur.push(''); }
    else if((c==='\n'||c==='\r') && !inQ){ if(cur.length>1||cur[0]!== '') rows.push(cur); cur=['']; if(c==='\r'&&text[i+1]==='\n') i++; }
    else { cur[cur.length-1]+=c; }
  }
  if(cur.length>1||cur[0]!=='') rows.push(cur);
  if(!rows.length) return { header:[], data:[] };
  const header = rows[0].map(h=>h.trim());
  const data = rows.slice(1).map(r=>{ const o={}; header.forEach((h,idx)=>o[h]=(r[idx]??'').trim()); return o; });
  return { header, data };
}

// ---- 4) Artwork helpers ----
const looksLikeImage = u => /\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(u||"");
const wsrv = url => !url ? "" : `https://wsrv.nl/?url=${encodeURIComponent("ssl:"+url.replace(/^https?:\/\//,''))}&w=1000&h=1000&fit=cover&output=webp&q=85`;

// Direct Wikipedia page → image
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

// Proxy through our Vercel serverless function (no 403/CORS)
async function resolveArt(artist, title, coverHint){
  const url = `/api/art?artist=${encodeURIComponent(artist||"")}&title=${encodeURIComponent(title||"")}&cover=${encodeURIComponent(coverHint||"")}`;
  try{
    const r = await fetch(url, { cache: "no-store
