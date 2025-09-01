/* Vinyl Collection — app.js */

const SHEET_CSV =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?output=csv";

const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwmcZPZbg3-Cfev8OTt_YGIsrTZ3Lb_BZ2xQ5bRxh9Hpy9OvkYkOqeubtl1MQ4OGqZAJw/exec";

const $ = (s, r = document) => r.querySelector(s);

const els = {
  header: document.querySelector('.site-header'),
  brandRow: document.querySelector('.brand-row'),
  brandBox: document.querySelector('.brand'),
  search: $('#search'),
  searchToggle: $('#searchToggle'),
  searchClose: $('#searchClose'),

  viewScrollBtn: $('#view-scroll'),
  viewGridBtn: $('#view-grid'),
  sort: $('#sort'),
  shuffle: $('#shuffle'),
  refresh: $('#refresh'),
  statsBtn: $('#statsBtn'),

  scroller: $('#scroller'),
  grid: $('#grid'),
  prev: $('#scrollPrev'),
  next: $('#scrollNext'),

  statsModal: $('#statsModal'),
  statsBody: $('#statsBody'),

  cardTpl: $('#cardTpl'),
  scrollView: $('#scrollView'),
  gridView: $('#gridView'),

  scanModal: $('#scanModal'),
  scanVideo: $('#scanVideo'),
  scanHint: $('#scanHint'),
  closeScan: $('#closeScan'),
  scanStatus: $('#scanStatus'),
  scanForm: $('#scanForm'),
  formUPC: $('#formUPC'),
  formArtist: $('#formArtist'),
  formTitle: $('#formTitle'),
  formGenre: $('#formGenre'),
  formNotes: $('#formNotes'),
  saveRecord: $('#saveRecord'),

  fab: $('#fab'),
  fabMenu: $('#fabMenu'),
  fabScan: $('#fabScan'),
  fabEnter: $('#fabEnter'),

  enterUPCModal: $('#enterUPCModal'),
  enterUPCForm: $('#enterUPCForm'),
  enterUPCInput: $('#enterUPCInput'),
};

(function setHeaderOffset(){
  const header = document.querySelector('.site-header');
  const apply = () => { if (header) document.documentElement.style.setProperty('--header-h', header.offsetHeight + 'px'); };
  window.addEventListener('load', apply, { once:true });
  window.addEventListener('resize', apply);
  if ('ResizeObserver' in window && header){ new ResizeObserver(apply).observe(header); } else { setTimeout(apply, 300); }
})();

function updateSearchMax(){
  if (!els.brandRow || !els.brandBox || !els.header) return;
  const rowW = els.brandRow.getBoundingClientRect().width;
  const brandW = els.brandBox.getBoundingClientRect().width;
  const safeGap = 12 + 40 + 8;
  const max = Math.max(180, Math.floor(rowW - brandW - safeGap));
  document.documentElement.style.setProperty('--search-max', max + 'px');
}
window.addEventListener('resize', updateSearchMax);
window.addEventListener('orientationchange', updateSearchMax);

(function wireSearch(){
  if (!els.search || !els.searchToggle || !els.searchClose || !els.header) return;

  let outsideHandler = null;
  let scrollHandler = null;

  const open = () => {
    els.header.classList.add('search-open');
    els.searchToggle.setAttribute('aria-expanded','true');
    updateSearchMax();
    setTimeout(()=> els.search.focus(), 60);

    outsideHandler = (ev) => {
      const container = els.header.querySelector('.search-inline');
      if (!container) return;
      if (!container.contains(ev.target)) close();
    };
    document.addEventListener('mousedown', outsideHandler);
    document.addEventListener('touchstart', outsideHandler, { passive:true });

    scrollHandler = () => close();
    window.addEventListener('scroll', scrollHandler, { passive:true });
  };

  const close = () => {
    els.header.classList.remove('search-open');
    els.searchToggle.setAttribute('aria-expanded','false');
    if (outsideHandler){
      document.removeEventListener('mousedown', outsideHandler);
      document.removeEventListener('touchstart', outsideHandler);
      outsideHandler = null;
    }
    if (scrollHandler){
      window.removeEventListener('scroll', scrollHandler);
      scrollHandler = null;
    }
  };

  els.searchToggle.addEventListener('click', () => {
    if (!els.header.classList.contains('search-open')) open();
  });
  els.searchClose.addEventListener('click', close);
  els.search.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') { close(); els.search.blur(); } });

  updateSearchMax();
})();

/* ---------- Data + rendering ---------- */
const state = {
  all: [], filtered: [],
  sortKey: 'title', view: 'scroll',
  mediaStream: null, scanning:false, rafId:null,
  detectorSupported: 'BarcodeDetector' in window, detector:null,
  usingZXing:false, zxingReader:null, zxingControls:null,
  handlingUPC:false, pending:null,
};
const withBust = (url) => `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`;

function parseCSV(text){
  const rows=[]; let cur=['']; let i=0,inQ=false;
  for(; i<text.length; i++){
    const c=text[i];
    if(c==='"'){ if(inQ && text[i+1]==='"'){ cur[cur.length-1]+='"'; i++; } else inQ=!inQ; }
    else if(c===',' && !inQ){ cur.push(''); }
    else if((c==='\n'||c==='\r') && !inQ){ rows.push(cur); cur=['']; if(c==='\r'&&text[i+1]==='\n') i++; }
    else { cur[cur.length-1]+=c; }
  }
  if(cur.length>1||cur[0]!=='') rows.push(cur);
  if(!rows.length) return {header:[],data:[]};
  const header=rows[0].map(h=>h.trim());
  const data=rows.slice(1).map(r=>{const o={}; header.forEach((h,idx)=>o[h]=(r[idx]??'').trim()); return o;});
  return {header,data};
}
const HEADER_ALIASES = {
  title:["title","album","record","release"],
  artist:["artist","artists","band"],
  genre:["genre","genres","style","category"],
  notes:["notes","special notes","comment","comments","description"],
  cover:["album artwork","artwork","cover","cover url","image","art","art url","artwork url"],
  alt:["alt artwork","alt image","alt cover","alt art"],
  upc:["upc","barcode","ean"],
};
function pickField(row, keys){
  const map={}; Object.keys(row).forEach(k=>map[k.trim().toLowerCase()]=k);
  for(const key of keys){ if(map[key]){ const v=row[map[key]]; if(v && String(v).trim()) return String(v).trim(); } }
  return "";
}
function wsrv(url){ return `https://wsrv.nl/?url=${encodeURIComponent(url)}&w=1000&h=1000&fit=cover&output=webp&q=85`; }
async function fromWikipediaPage(u){
  const m=u.match(/https?:\/\/(?:\w+\.)?wikipedia\.org\/wiki\/([^?#]+)/i); if(!m) return "";
  const title=decodeURIComponent(m[1]);
  try{ const r=await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
       if(!r.ok) return ""; const j=await r.json();
       return j?.originalimage?.source || j?.thumbnail?.source || ""; }catch{ return ""; }
}
async function chooseCover(coverRaw, altRaw){
  const c=coverRaw||altRaw||""; if(!c) return "";
  if(/wikipedia\.org\/wiki\//i.test(c)){ const img=await fromWikipediaPage(c); return img?wsrv(img):""; }
  if(/^https?:\/\//i.test(c)) return wsrv(c);
  return "";
}
function placeholderFor(a,b){
  const letter=(b||a||"?").trim().charAt(0).toUpperCase()||"?";
  const svg=`<svg xmlns='http://www.w3.org/2000/svg' width='1000' height='1000'>
    <rect width='100%' height='100%' fill='#12161c'/><circle cx='500' cy='500' r='380' fill='#0c1117'/>
    <text x='50%' y='56%' text-anchor='middle' font-family='Inter,Arial' font-size='420' font-weight='800' fill='#c8ccd4'>${letter}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

async function loadFromSheet(forceFresh=false){
  const url = forceFresh ? withBust(SHEET_CSV) : SHEET_CSV;
  const res = await fetch(url, { cache:"no-store" });
  const text = await res.text();
  if(!text || text.trim().startsWith("<")){ console.error("Not CSV"); return; }
  const { data } = parseCSV(text);

  const recs=[];
  for(const row of data){
    const title=pickField(row,HEADER_ALIASES.title);
    const artist=pickField(row,HEADER_ALIASES.artist);
    const notes=pickField(row,HEADER_ALIASES.notes);
    const genre=pickField(row,HEADER_ALIASES.genre);
    const coverRaw=pickField(row,HEADER_ALIASES.cover);
    const altRaw=pickField(row,HEADER_ALIASES.alt);
    const upc=pickField(row,HEADER_ALIASES.upc);
    if(!title && !artist) continue;
    recs.push({ title,artist,notes,genre,coverRaw,altRaw,upc,cover:"" });
  }

  state.all = recs;
  state.filtered = [...recs];
  applySort(); render();

  await resolveCovers(recs,6);
  render();
}
async function resolveCovers(records,concurrency=6){
  let i=0; const workers=Array.from({length:concurrency},async()=>{
    while(i<records.length){ const idx=i++; const r=records[idx];
      try{ r.cover=await chooseCover(r.coverRaw,r.altRaw); }catch{ r.cover=""; }
    }
  }); await Promise.all(workers);
}

function createCard(rec){
  const tpl=els.cardTpl?.content?.firstElementChild;
  const node=tpl?tpl.cloneNode(true):document.createElement('article');
  if(!tpl){
    node.className='card'; node.innerHTML=`
      <div class="sleeve">
        <div class="face front"><img class="cover" alt=""></div>
        <div class="face back">
          <div class="meta">
            <h3 class="title"></h3><p class="artist"></p><p class="genre"></p><p class="notes"></p>
          </div>
        </div>
      </div>
      <div class="caption"><div class="caption-title"></div><div class="caption-artist"></div></div>`;
  }
  const titleEl=node.querySelector('.title');
  const artistEl=node.querySelector('.artist');
  const genreEl=node.querySelector('.genre');
  const notesEl=node.querySelector('.notes');
  const imgEl=node.querySelector('img.cover');
  const cTitle=node.querySelector('.caption-title');
  const cArtist=node.querySelector('.caption-artist');
  const sleeve=node.querySelector('.sleeve');

  const title=rec.title||"Untitled"; const artist=rec.artist||"Unknown Artist";
  titleEl.textContent=title; artistEl.textContent=artist;
  genreEl.textContent=rec.genre?`Genre: ${rec.genre}`:""; notesEl.textContent=rec.notes||"";
  cTitle.textContent=title; cArtist.textContent=artist;

  imgEl.src=placeholderFor(title,artist); imgEl.alt=`${title} — ${artist}`;
  if(rec.cover){ const real=new Image(); real.referrerPolicy='no-referrer';
    real.onload=()=>{ imgEl.src=rec.cover; }; real.onerror=()=>{}; real.src=rec.cover; }

  // Tap = flip + light circle pulse
  node.addEventListener('click',()=>{
    node.classList.toggle('flipped');
    if (sleeve){
      sleeve.classList.remove('pulse'); // restart animation if tapped fast
      // force reflow
      void sleeve.offsetWidth;
      sleeve.classList.add('pulse');
    }
  });

  return node;
}

function centerFirstCardIfMobile(){
  const isMobile = window.matchMedia('(max-width: 720px)').matches;
  if (!isMobile || !els.scrollView.classList.contains('active')) return;
  const first = els.scroller.querySelector('.card');
  if (!first) return;
  requestAnimationFrame(()=>{
    const targetLeft = first.offsetLeft + first.offsetWidth/2 - els.scroller.clientWidth/2;
    els.scroller.scrollLeft = Math.max(0, Math.round(targetLeft));
  });
}

const cardsList = () => Array.from(els.scroller.querySelectorAll('.card'));
function currentCenteredIndex(){
  const cards = cardsList();
  if (!cards.length) return 0;
  const scRect = els.scroller.getBoundingClientRect();
  const centerX = scRect.left + scRect.width/2;
  let best = 0, bestDist = Infinity;
  for (let i=0;i<cards.length;i++){
    const r = cards[i].getBoundingClientRect();
    const c = r.left + r.width/2;
    const d = Math.abs(c - centerX);
    if (d < bestDist){ bestDist = d; best = i; }
  }
  return best;
}
function scrollToIndex(idx){
  const cards = cardsList();
  if (!cards.length) return;
  idx = Math.max(0, Math.min(idx, cards.length-1));
  const card = cards[idx];
  const left = card.offsetLeft + card.offsetWidth/2 - els.scroller.clientWidth/2;
  els.scroller.scrollTo({ left: Math.max(0, Math.round(left)), behavior: 'smooth' });
}
function renderScroll(){
  els.scroller.innerHTML = '';
  state.filtered.forEach(r => els.scroller.appendChild(createCard(r)));
  centerFirstCardIfMobile();
}
function renderGrid(){
  els.grid.innerHTML = '';
  state.filtered.forEach(r => els.grid.appendChild(createCard(r)));
}
function render(){
  const isScroll=state.view==='scroll';
  els.scrollView.classList.toggle('active',isScroll);
  els.gridView.classList.toggle('active',!isScroll);
  els.viewScrollBtn.classList.toggle('active',isScroll);
  els.viewGridBtn.classList.toggle('active',!isScroll);
  if(isScroll){ renderScroll(); toggleArrows(true); } else { renderGrid(); toggleArrows(false); }
}
window.addEventListener('resize', centerFirstCardIfMobile);
window.addEventListener('orientationchange', centerFirstCardIfMobile);

/* Search / Sort / Shuffle */
function applySort(){
  const k=state.sortKey;
  state.filtered.sort((a,b)=> (a[k]||"").toLowerCase().localeCompare((b[k]||"").toLowerCase()));
}
els.search.addEventListener('input',(e)=>{
  const q=e.target.value.trim().toLowerCase();
  state.filtered=state.all.filter(r=>`${r.title} ${r.artist} ${r.genre} ${r.notes}`.toLowerCase().includes(q));
  applySort(); render();
});
els.sort.addEventListener('change',()=>{ state.sortKey=els.sort.value||'title'; applySort(); render(); });
els.shuffle.addEventListener('click',()=>{
  for(let i=state.filtered.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [state.filtered[i], state.filtered[j]] = [state.filtered[j], state.filtered[i]];
  }
  render();
});

/* View toggles + arrows */
els.viewScrollBtn.addEventListener('click',()=>{ state.view='scroll'; render(); });
els.viewGridBtn.addEventListener('click',()=>{ state.view='grid'; render(); });
function toggleArrows(show){ els.prev.style.display=show?'':'none'; els.next.style.display=show?'':'none'; }
els.prev.addEventListener('click',()=>{ scrollToIndex(currentCenteredIndex() - 1); });
els.next.addEventListener('click',()=>{ scrollToIndex(currentCenteredIndex() + 1); });

/* Stats (same logic as before, shortened here) */
function buildStats(recs){
  const total=recs.length, artistMap=new Map(), genreMap=new Map();
  for(const r of recs){
    if(r.artist) artistMap.set(r.artist,(artistMap.get(r.artist)||0)+1);
    if(r.genre) String(r.genre).split(/[\/,&]| and /i).map(s=>s.trim()).filter(Boolean)
      .forEach(g=>genreMap.set(g,(genreMap.get(g)||0)+1));
  }
  return {
    total, uniqArtists:artistMap.size,
    topArtists:[...artistMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10),
    topGenres:[...genreMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12)
  };
}
function openStats(){
  const s=buildStats(state.filtered); const body=els.statsBody; body.innerHTML='';
  const grid=document.createElement('div'); grid.className='stat-grid';
  grid.innerHTML=`
    <div class="stat-tile"><div>Total Albums</div><div class="stat-big">${s.total}</div></div>
    <div class="stat-tile"><div>Unique Artists</div><div class="stat-big">${s.uniqArtists}</div></div>
    <div class="stat-tile"><div>Total Genres</div><div class="stat-big">${s.topGenres.length}</div></div>`;
  body.appendChild(grid);
  els.statsModal.showModal();
}
els.statsBtn.addEventListener('click',openStats);

/* UPC lookup + save */
async function lookupByUPC(upc){
  const url=`https://musicbrainz.org/ws/2/release/?query=barcode:${encodeURIComponent(upc)}&fmt=json`;
  const r=await fetch(url,{ headers:{ 'Accept':'application/json' }});
  if(!r.ok) throw new Error('MusicBrainz request failed');
  const j=await r.json(); const releases=j?.releases||[];
  if(!releases.length) throw new Error('No releases found for that UPC');

  releases.sort((a,b)=>{
    const af = a['cover-art-archive']?.front ? 1 : 0;
    const bf = b['cover-art-archive']?.front ? 1 : 0;
    if (af !== bf) return bf - af;
    return (b.score||0) - (a.score||0);
  });

  const rel=releases[0];
  const mbid=rel.id;
  const title=rel.title||'';
  const artist=(rel['artist-credit']||[]).map(c=>c?.name||c?.artist?.name).filter(Boolean).join(', ') || (rel['artist-credit-phrase']||'');

  let coverUrl = "";
  if (rel['cover-art-archive']?.front) {
    coverUrl = `https://coverartarchive.org/release/${mbid}/front-500`;
  } else if (rel['release-group']?.id) {
    coverUrl = `https://coverartarchive.org/release-group/${rel['release-group'].id}/front-500`;
  }

  return { title, artist, upc, coverRaw: coverUrl || "", altRaw:"", notes:"", genre:"" };
}
async function addRecordToSheet(rec){
  const form=new URLSearchParams({
    title:rec.title||"", artist:rec.artist||"", upc:rec.upc||"",
    genre:rec.genre||"", notes:rec.notes||"",
    cover:rec.coverRaw||"", alt:rec.altRaw||""
  });
  const resp = await fetch(APPS_SCRIPT_URL,{ method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8' }, body: form.toString() });
  let json=null, text="";
  try { json = await resp.clone().json(); } catch { text = await resp.text().catch(()=>"(no body)"); }
  if(!json || !json.ok){
    const snippet = (text || JSON.stringify(json)).slice(0,300).replace(/\s+/g,' ').trim();
    throw new Error(`Server did not confirm (status ${resp.status}). Response: ${snippet || '(empty)'}`);
  }
  return json;
}
async function addToCollection(rec){
  rec.cover = await chooseCover(rec.coverRaw, rec.altRaw);
  state.all.unshift(rec); state.filtered=[...state.all]; applySort(); render();
  await addRecordToSheet(rec);
}

/* Scanning engines */
async function loadZXing(){
  if (window.ZXing && window.ZXing.BrowserMultiFormatReader) {
    return {
      BrowserMultiFormatReader: window.ZXing.BrowserMultiFormatReader,
      BarcodeFormat: window.ZXing.BarcodeFormat,
      DecodeHintType: window.ZXing.DecodeHintType
    };
  }
  try {
    return await import('https://cdn.jsdelivr.net/npm/@zxing/library@0.21.2/esm/index.min.js');
  } catch {
    await new Promise((resolve, reject)=>{
      const s=document.createElement('script');
      s.src='https://cdn.jsdelivr.net/npm/@zxing/library@0.21.2/umd/index.min.js';
      s.onload=resolve; s.onerror=reject; document.head.appendChild(s);
    });
    return {
      BrowserMultiFormatReader: window.ZXing.BrowserMultiFormatReader,
      BarcodeFormat: window.ZXing.BarcodeFormat,
      DecodeHintType: window.ZXing.DecodeHintType
    };
  }
}
async function startZXing(){
  const { BrowserMultiFormatReader, BarcodeFormat, DecodeHintType } = await loadZXing();
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A,  BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_128, BarcodeFormat.CODE_39
  ]);
  const reader = new BrowserMultiFormatReader(hints);
  state.zxingReader = reader;
  state.usingZXing = true;

  const constraints = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };

  return new Promise((resolve, reject)=>{
    reader.decodeFromConstraints(constraints, els.scanVideo, async (result, err, controls)=>{
      if (controls && !state.zxingControls) state.zxingControls = controls;
      if (result && !state.handlingUPC) {
        state.handlingUPC = true;
        try { await handleUPC(result.getText()); } finally { resolve(); }
      } else if (err && !(err && err.name === 'NotFoundException')) {
        reject(err);
      }
    });
  });
}
async function startBDCamera(){
  const constraints={ video:{ facingMode:{ ideal:'environment' }, width:{ ideal:1280 }, height:{ ideal:720 } }, audio:false };
  state.mediaStream=await navigator.mediaDevices.getUserMedia(constraints);
  els.scanVideo.srcObject=state.mediaStream; await els.scanVideo.play();

  if(!state.detector){
    try { state.detector=new window.BarcodeDetector({ formats:['ean_13','ean_8','upc_a','upc_e','code_128','code_39'] }); }
    catch { state.detector=new window.BarcodeDetector(); }
  }
  state.scanning = true; els.scanHint.textContent = 'Point your camera at the barcode.'; scanLoop();
}
async function scanLoop(){
  if(!state.scanning) return;
  try{
    if(state.detector){
      const codes=await state.detector.detect(els.scanVideo);
      if(codes && codes.length){
        const upcRaw=(codes[0].rawValue||"").trim();
        if(upcRaw && !state.handlingUPC){
          state.handlingUPC = true;
          await handleUPC(upcRaw);
          return;
        }
      }
    }
  }catch(err){ console.error('scanLoop error',err); }
  state.rafId=requestAnimationFrame(scanLoop);
}
async function startScanEngine(){
  state.handlingUPC = false;
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  try{
    if (isMobile || !state.detectorSupported) {
      els.scanHint.textContent = 'Scanning (ZXing)…'; await startZXing();
    } else {
      await startBDCamera();
      setTimeout(async ()=>{
        if (!state.handlingUPC && !state.usingZXing && els.scanModal.open) {
          await stopScanEngines();
          els.scanHint.textContent = 'Scanning (ZXing)…';
          await startZXing();
        }
      }, 4000);
    }
  }catch(err){
    console.error('Start scan error', err);
    if (!state.usingZXing) {
      try { els.scanHint.textContent = 'Scanning (ZXing)…'; await startZXing(); }
      catch { els.scanStatus.textContent='Live scan not available. Use “Enter UPC manually.”'; }
    } else {
      els.scanStatus.textContent='Live scan not available. Use “Enter UPC manually.”';
    }
  }
}
async function stopScanEngines(){
  state.scanning=false;
  if(state.rafId) cancelAnimationFrame(state.rafId);
  if(state.mediaStream){ for(const t of state.mediaStream.getTracks()){ t.stop(); } state.mediaStream=null; }
  els.scanVideo.pause(); els.scanVideo.srcObject=null;
  if (state.zxingControls) { try { state.zxingControls.stop(); } catch{} state.zxingControls = null; }
  if (state.zxingReader) { try { state.zxingReader.reset(); } catch{} state.zxingReader = null; }
  state.usingZXing = false;
}

async function openScanModal(){
  els.scanStatus.textContent=''; state.pending=null; els.scanForm.reset(); els.formUPC.value=""; els.saveRecord.disabled=true;
  els.scanModal.showModal(); document.body.classList.add('modal-open');
  try{ els.scanHint.textContent='Starting camera…'; await startScanEngine(); }
  catch{ els.scanStatus.textContent='Camera unavailable. Use “Enter UPC manually.”'; }
}
function closeScanModal(){ stopScanEngines(); els.scanModal.close(); document.body.classList.remove('modal-open'); }
els.closeScan?.addEventListener('click',closeScanModal);

async function handleUPC(upc){
  if (!els.scanModal.open) { await openScanModal(); }
  await stopScanEngines();
  els.scanStatus.textContent=`UPC: ${upc} — looking up…`;
  try{
    const rec=await lookupByUPC(upc); state.pending=rec;
    els.formUPC.value=rec.upc||upc; els.formArtist.value=rec.artist||""; els.formTitle.value=rec.title||"";
    els.formGenre.value=rec.genre||""; els.formNotes.value=""; els.saveRecord.disabled=false;
    els.scanStatus.textContent=`Found: ${rec.artist || '(unknown)'} — ${rec.title || '(unknown)'} • review & Save`;
    els.formArtist.focus();
  }catch{
    state.pending={ upc, title:"", artist:"", genre:"", notes:"", coverRaw:"", altRaw:"" };
    els.formUPC.value=upc; els.formArtist.value=""; els.formTitle.value=""; els.formGenre.value=""; els.formNotes.value="";
    els.saveRecord.disabled=false; els.scanStatus.textContent=`No match found. Enter details and Save`; els.formArtist.focus();
  } finally { state.handlingUPC = false; }
}

els.scanForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const upc=(els.formUPC.value||"").trim();
  const artist=(els.formArtist.value||"").trim();
  const title=(els.formTitle.value||"").trim();
  const genre=(els.formGenre.value||"").trim();
  const notes=(els.formNotes.value||"").trim();
  if(!upc){ alert("UPC is required (scan or enter manually)."); return; }
  if(!artist && !title){ alert("Please enter at least a Title or Artist."); return; }

  const rec = Object.assign(
    { upc, artist, title, genre, notes, coverRaw:"", altRaw:"" },
    state.pending ? { coverRaw: state.pending.coverRaw || "" } : {}
  );

  const prevLabel = els.saveRecord.textContent;
  els.saveRecord.textContent = 'Saving...';
  els.saveRecord.disabled = true;
  els.scanStatus.textContent = "Saving…";

  try{
    await addToCollection(rec);
    els.scanStatus.textContent = "Saved";
    setTimeout(()=> closeScanModal(), 700);
  }catch(err){
    els.scanStatus.textContent = "Saved locally. " + err.message;
  } finally {
    els.saveRecord.textContent = prevLabel || 'Save';
    els.saveRecord.disabled = false;
  }
});

/* Update Collection */
els.refresh?.addEventListener('click', async ()=>{
  if (els.scanModal?.open) closeScanModal();
  const originalText = els.refresh.textContent;
  els.refresh.disabled = true; els.refresh.textContent = 'Updating…';
  try { state.all = []; state.filtered = []; render(); await loadFromSheet(true); }
  catch { alert('Update failed. Check your published CSV link.'); }
  finally { els.refresh.disabled = false; els.refresh.textContent = originalText; }
});

/* FAB behavior */
els.fab.addEventListener('click', ()=> { els.fabMenu.showModal(); });
els.fabScan.addEventListener('click', async ()=>{
  els.fabMenu.close();
  await openScanModal();
});
els.fabEnter.addEventListener('click', ()=>{
  els.fabMenu.close();
  els.enterUPCModal.showModal();
  setTimeout(()=> els.enterUPCInput.focus(), 75);
});
els.enterUPCForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const raw = (els.enterUPCInput.value||"").replace(/\D+/g,'').trim();
  if(!raw){ els.enterUPCModal.close(); return; }
  els.enterUPCModal.close();
  await handleUPC(raw);
});

/* Kickoff */
loadFromSheet().then(()=>{
  updateSearchMax();
  centerFirstCardIfMobile();
}).catch(()=>{
  alert("Couldn’t load the Google Sheet. Make sure your link is published as CSV (output=csv).");
});
