
const SHEET_CSV = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?gid=0&single=true&output=csv';
const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0%" stop-color="#111a36"/><stop offset="100%" stop-color="#0b1228"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="200" cy="200" r="110" fill="#141f40"/><circle cx="200" cy="200" r="10" fill="#0b1020"/><text x="50%" y="52%" text-anchor="middle" fill="#9fb7ff" font-size="42" font-family="sans-serif">🎵</text></svg>`);
const state = { all: [], filtered: [], view: 'scroll' };
const $ = s => document.querySelector(s);
const el = (t,c) => { const n=document.createElement(t); if(c) n.className=c; return n; };

function sanitizeCoverURL(u){
  if(!u) return '';
  try{
    u = (''+u).trim();
    const m = u.match(/[-\w]{25,}/);
    if(u.includes('drive.google.com') && m){
      return `https://drive.google.com/uc?export=download&id=${m[0]}`;
    }
    if(u.includes('dropbox.com')){
      return u.replace('www.dropbox.com','dl.dropboxusercontent.com').replace('?dl=0','');
    }
    return u;
  }catch{return (''+u)}
}
function csvToArray(text){
  if (window.Papa){
    const out = Papa.parse(text, { header:true, skipEmptyLines:true });
    return out.data;
  }
  const [h,...rows]=text.trim().split(/\r?\n/);
  const cols=h.split(',');
  return rows.map(r=>{
    const p=r.split(','); const o={};
    cols.forEach((c,i)=>o[c.trim()]=(p[i]||'').trim());
    return o;
  });
}
async function fetchSheet(){
  const res = await fetch(SHEET_CSV, { cache: 'no-store' });
  const text = await res.text();
  const rows = csvToArray(text);
  return rows.map(r=>{
    const title = (r.Title || r.Album || r.album || '').trim();
    const artist = (r.Artist || r.artist || '').trim();
    const cover = sanitizeCoverURL((r.Cover || r.Image || r.Art || '').trim());
    const genre = (r.Genre || r.genre || '').trim();
    return { title, artist, cover, genre };
  }).filter(x=>x.title && x.artist);
}
function makeCard(rec){
  const tpl = $('#cardTpl');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.querySelector('.title').textContent = rec.title;
  node.querySelector('.artist').textContent = rec.artist;
  node.querySelector('.genre').textContent = rec.genre ? `Genre: ${rec.genre}` : '';
  node.querySelector('.caption-title').textContent = rec.title;
  node.querySelector('.caption-artist').textContent = rec.artist;
  const img = node.querySelector('img.cover');
  img.src = rec.cover || PLACEHOLDER;
  img.alt = `${rec.title} — ${rec.artist}`;
  img.addEventListener('error', ()=>{ img.src = PLACEHOLDER; }, { once:true });
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
function render(){
  const list = state.filtered;
  const scroller = $('#scroller');
  scroller.innerHTML=''; const f1=document.createDocumentFragment();
  list.forEach(r=>f1.appendChild(makeCard(r))); scroller.appendChild(f1);
  const grid = $('#grid');
  grid.innerHTML=''; const f2=document.createDocumentFragment();
  list.forEach(r=>f2.appendChild(makeCard(r))); grid.appendChild(f2);
  enableWheelHScroll(scroller);
}
function setView(mode){
  state.view = mode;
  $('#scrollView').classList.toggle('active', mode==='scroll');
  $('#gridView').classList.toggle('active', mode==='grid');
  $('#view-scroll').classList.toggle('active', mode==='scroll');
  $('#view-grid').classList.toggle('active', mode==='grid');
}
function applyFilter(q){
  q = (q||'').trim().toLowerCase();
  if (!q) state.filtered = state.all.slice();
  else state.filtered = state.all.filter(r => r.title.toLowerCase().includes(q) || r.artist.toLowerCase().includes(q));
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
function buildStats(items){
  const total = items.length;
  const map = new Map();
  items.forEach(r=>{
    const g=(r.genre||'').trim(); if(!g) return;
    map.set(g, (map.get(g)||0)+1);
  });
  const entries = Array.from(map.entries()).sort((a,b)=>b[1]-a[1]);
  return { total, genres: entries };
}
function openStats(){
  const s = buildStats(state.filtered);
  const body = $('#statsBody'); body.innerHTML='';
  const totalEl = el('div','stat-total'); totalEl.innerHTML = `<strong>Total albums:</strong> ${s.total}`; body.appendChild(totalEl);
  if (s.genres.length){
    const h = el('h3'); h.textContent='Top Genres'; body.appendChild(h);
    const ul = el('ul','genre-list'); s.genres.forEach(([g,n])=>{ const li=el('li'); li.textContent=`${g} — ${n}`; ul.appendChild(li); }); body.appendChild(ul);
  } else { const p=el('p'); p.textContent='No genres found. Add a Genre column in your sheet to see stats.'; body.appendChild(p); }
  $('#statsModal').showModal();
}
document.addEventListener('DOMContentLoaded', async () => {
  const search = $('#search');
  $('#view-scroll').addEventListener('click', ()=> setView('scroll'));
  $('#view-grid').addEventListener('click', ()=> setView('grid'));
  $('#shuffle').addEventListener('click', shuffle);
  $('#prev').addEventListener('click', ()=> nextCard(-1));
  $('#next').addEventListener('click', ()=> nextCard(1));
  $('#statsBtn').addEventListener('click', openStats);
  search.addEventListener('input', e => applyFilter(e.target.value));
  try{
    state.all = await fetchSheet();
    state.filtered = state.all.slice();
    setView('scroll'); render();
  }catch(e){
    console.error(e);
    alert('Could not load your Google Sheet. Make sure it is published as CSV.');
  }
  document.addEventListener('keydown', (e)=>{
    if (state.view!=='scroll') return;
    if (e.key==='ArrowRight') nextCard(1);
    if (e.key==='ArrowLeft') nextCard(-1);
  });
});
