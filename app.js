/* -------------------------------------------------------
   Vinyl Collection — Single-file app logic
   CSV Source (Publish to web → CSV):
   https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?output=csv
--------------------------------------------------------*/

// ---------- 0) Config ----------
const SHEET_CSV =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?output=csv";

const HEADER_ALIASES = {
  title:   ["title","album","record","release"],
  artist:  ["artist","artists","band"],
  genre:   ["genre","genres","style","category"],
  notes:   ["notes","special notes","comment","comments","description"],
  cover:   ["album artwork","artwork","cover","cover url","image","art","art url","artwork url"],
  altCover:["alt artwork","alt cover","alternate artwork","alternate cover"]
};

// ---------- 1) Elements ----------
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];

const els = {
  search:     $('#search'),
  viewScroll: $('#viewScroll'),
  viewGrid:   $('#viewGrid'),
  sort:       $('#sortSelect'),
  shuffle:    $('#btnShuffle'),
  statsBtn:   $('#btnStats'),
  grid:       $('#grid'),
  scroller:   $('#scroller'),
  scrollWrap: $('.scroller-wrap'),
  statsDlg:   $('#statsModal'),
  statsBody:  $('#statsBody'),
  tpl:        $('#cardTpl')
};

// ---------- 2) State ----------
const state = {
  all: [],
  filtered: [],
  view: 'scroll',     // 'scroll' | 'grid'
  sortKey: 'title'    // 'title' | 'artist'
};

// ---------- 3) CSV parsing ----------
function pick(obj, synonyms){
  const keys = Object.keys(obj);
  for (const key of synonyms){
    const hit = keys.find(h => h.trim().toLowerCase() === key);
    if (hit && String(obj[hit]).trim()) return String(obj[hit]).trim();
  }
  return "";
}

// tiny CSV parser (handles quotes)
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

// ---------- 4) Artwork helpers ----------
function looksLikeImage(u){ return /\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i.test(u||""); }
function wsrv(url){
  if(!url) return "";
  const u = url.replace(/^https?:\/\//, "");
  return `https://wsrv.nl/?url=${encodeURIComponent("ssl:"+u)}&w=1200&h=1200&fit=cover&output=webp&q=85`;
}
function chooseCover(coverRaw, altRaw){
  // Only accept direct images; otherwise return empty to show placeholder
  if (looksLikeImage(coverRaw)) return wsrv(coverRaw);
  if (looksLikeImage(altRaw))   return wsrv(altRaw);
  return "";
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
      const title   = pick(r, HEADER_ALIASES.title);
      const artist  = pick(r, HEADER_ALIASES.artist);
      const genre   = pick(r, HEADER_ALIASES.genre);
      const notes   = pick(r, HEADER_ALIASES.notes);
      const coverRaw   = pick(r, HEADER_ALIASES.cover);
      const altCoverRaw= pick(r, HEADER_ALIASES.altCover);
      const cover  = chooseCover(coverRaw, altCoverRaw);
      return { title, artist, genre, notes, cover };
    }).filter(x => x.title || x.artist);

    state.all = normalized;
    state.filtered = [...normalized];
    applySort();
    render();
    // Remove any old status banner
    $('#status')?.remove();
  }catch(e){
    console.error(e);
    showStatus("Couldn’t load your Google Sheet. Check the URL or try again.");
  }
}

// ---------- 6) Rendering ----------
const io = new IntersectionObserver((entries)=>{
  for(const ent of entries){
    if(ent.isIntersecting){
      const img = ent.target;
      const src = img.dataset.src;
      if(src && !img.src){
        img.src = src;
        img.addEventListener('load', ()=>{
          img.previousElementSibling?.classList.add('img-loaded'); // hide skeleton
        }, { once:true });
      }
      io.unobserve(img);
    }
  }
}, { rootMargin: "800px 0px" });

function createCard(rec){
  cons
