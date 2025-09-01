/* -------------------------------------------
   Vinyl Collection — app.js
   - Scan modal: scan → autofill form → user submits to save
   - "Update Collection" button: clear local state & reload from Sheet
   - Mobile-friendly scanning: ZXing fallback for iOS/Android
   - Detailed server error reporting
--------------------------------------------*/

// 0) CONFIG
const SHEET_CSV =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?output=csv";

// IMPORTANT: paste your *current* Web App URL (/exec) here
const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwmcZPZbg3-Cfev8OTt_YGIsrTZ3Lb_BZ2xQ5bRxh9Hpy9OvkYkOqeubtl1MQ4OGqZAJw/exec";

// 1) ELEMENTS
const $ = (s, r = document) => r.querySelector(s);

const els = {
  search: $('#search'),
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
  // Scan
  scanBtn: $('#scanBtn'),
  scanModal: $('#scanModal'),
  scanVideo: $('#scanVideo'),
  scanHint: $('#scanHint'),
  manualUPC: $('#manualUPC'),
  closeScan: $('#closeScan'),
  scanStatus: $('#scanStatus'),
  // Form
  scanForm: $('#scanForm'),
  formUPC: $('#formUPC'),
  formArtist: $('#formArtist'),
  formTitle: $('#formTitle'),
  formGenre: $('#formGenre'),
  formNotes: $('#formNotes'),
  saveRecord: $('#saveRecord'),
};

// 2) STATE
const state = {
  all: [],
  filtered: [],
  sortKey: 'title',
  view: 'scroll',
  // scanning engines
  mediaStream: null,              // for BarcodeDetector path
  scanning: false,
  rafId: null,
  detectorSupported: 'BarcodeDetector' in window,
  detector: null,
  usingZXing: false,
  zxingReader: null,
  zxingControls: null,
  handlingUPC: false,
  pending: null,
};

// 3) CSV PARSER
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

// 4) HEADER PICKING
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

// 5) ARTWORK HELPERS
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
    <rect width='100%' height='100%' fill='#1b2330'/><circle cx='500' cy='500' r='380' fill='#121a26'/>
    <text x='50%' y='56%' text-anchor='middle' font-family='Inter,Arial' font-size='420' font-weight='800' fill='#a7b9da'>${letter}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// 6) LOAD & NORMALIZE (source of truth = Google Sheet)
async function loadFromSheet(){
  const res = await fetch(SHEET_CSV, { cache:"no-store" }); const text = await res.text();
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
  state.all=recs; state.filtered=[...recs]; applySort(); render();
  await resolveCovers(recs,6); render();
}
async function resolveCovers(records,concurrency=6){
  let i=0; const workers=Array.from({length:concurrency},async()=>{
    while(i<records.length){ const idx=i++; const r=records[idx];
      try{ r.cover=await chooseCover(r.coverRaw,r.altRaw); }catch{ r.cover=""; }
    }
  }); await Promise.all(workers);
}

// 7) RENDER
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

  const title=rec.title||"Untitled"; const artist=rec.artist||"Unknown Artist";
  titleEl.textContent=title; artistEl.textContent=artist;
  genreEl.textContent=rec.genre?`Genre: ${rec.genre}`:""; notesEl.textContent=rec.notes||"";
  cTitle.textContent=title; cArtist.textContent=artist;

  imgEl.src=placeholderFor(title,artist); imgEl.alt=`${title} — ${artist}`;
  if(rec.cover){ const real=new Image(); real.referrerPolicy='no-referrer';
    real.onload=()=>{ imgEl.src=rec.cover; }; real.onerror=()=>{}; real.src=rec.cover; }
  node.addEventListener('click',()=>node.classList.toggle('flipped'));
  return node;
}
function renderScroll(){ els.scroller.innerHTML=''; state.filtered.forEach(r=>els.scroller.appendChild(createCard(r))); els.scroller.scrollLeft=0; }
function renderGrid(){ els.grid.innerHTML=''; state.filtered.forEach(r=>els.grid.appendChild(createCard(r))); }
function render(){
  const isScroll=state.view==='scroll';
  els.scrollView.classList.toggle('active',isScroll);
  els.gridView.classList.toggle('active',!isScroll);
  els.viewScrollBtn.classList.toggle('active',isScroll);
  els.viewGridBtn.classList.toggle('active',!isScroll);
  if(isScroll){ renderScroll(); toggleArrows(true); } else { renderGrid(); toggleArrows(false); }
}

// 8) SEARCH / SORT / SHUFFLE
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

// NEW: Update button — reload from Sheet & clear local state
els.refresh?.addEventListener('click', async ()=>{
  if (els.scanModal?.open) closeScanModal();
  els.search.value = '';
  state.pending = null;
  els.scanForm?.reset?.();
  if (els.formUPC) els.formUPC.value = '';
  if (els.saveRecord) els.saveRecord.disabled = true;
  els.scanStatus.textContent = '';

  const originalText = els.refresh.textContent;
  els.refresh.disabled = true; els.refresh.textContent = 'Updating…';
  try {
    state.all = []; state.filtered = []; render();
    await loadFromSheet();
  } catch (err) {
    console.error(err);
    alert('Update failed. Check your published CSV link.');
  } finally {
    els.refresh.disabled = false; els.refresh.textContent = originalText;
  }
});

// 9) VIEW TOGGLES
els.viewScrollBtn.addEventListener('click',()=>{ state.view='scroll'; render(); });
els.viewGridBtn.addEventListener('click',()=>{ state.view='grid'; render(); });

// 10) ARROWS
function toggleArrows(show){ els.prev.style.display=show?'':'none'; els.next.style.display=show?'':'none'; }
function scrollByAmount(px){ els.scroller.scrollBy({ left:px, behavior:'smooth' }); }
els.prev.addEventListener('click',()=>scrollByAmount(-Math.round(els.scroller.clientWidth*0.9)));
els.next.addEventListener('click',()=>scrollByAmount(Math.round(els.scroller.clientWidth*0.9)));

// 11) STATS
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
  if(s.topArtists.length){ const h=document.createElement('h3'); h.textContent='Top Artists'; body.appendChild(h);
    const chips=document.createElement('div'); chips.className='chips';
    s.topArtists.forEach(([name,n])=>{ const c=document.createElement('span'); c.className='chip'; c.textContent=`${name} • ${n}`; chips.appendChild(c); });
    body.appendChild(chips);
  }
  if(s.topGenres.length){ const h=document.createElement('h3'); h.textContent='Top Genres'; body.appendChild(h);
    const chips=document.createElement('div'); chips.className='chips';
    s.topGenres.forEach(([g,n])=>{ const c=document.createElement('span'); c.className='chip'; c.textContent=`${g} • ${n}`; chips.appendChild(c); });
    body.appendChild(chips);
  }
  els.statsModal.showModal();
}
els.statsBtn.addEventListener('click',openStats);

// 12) UPC LOOKUP (MusicBrainz + Cover Art Archive)
async function lookupByUPC(upc){
  const url=`https://musicbrainz.org/ws/2/release/?query=barcode:${encodeURIComponent(upc)}&fmt=json`;
  const r=await fetch(url,{ headers:{ 'Accept':'application/json' }});
  if(!r.ok) throw new Error('MusicBrainz request failed');
  const j=await r.json(); const releases=j?.releases||[];
  if(!releases.length) throw new Error('No releases found for that UPC');
  releases.sort((a,b)=>{ const ac=(a['cover-art-archive']?.front?1:0)-(b['cover-art-archive']?.front?1:0); if(ac!==0) return -ac; return (b.score||0)-(a.score||0); });
  const rel=releases[0];
  const mbid=rel.id;
  const title=rel.title||'';
  const artist=(rel['artist-credit']||[]).map(c=>c?.name||c?.artist?.name).filter(Boolean).join(', ') || (rel['artist-credit-phrase']||'');
  let coverUrl="";
  try{
    const artJson=await fetch(`https://coverartarchive.org/release/${mbid}`,{ headers:{ 'Accept':'application/json' }});
    if(artJson.ok){ const art=await artJson.json(); const front=(art.images||[]).find(img=>img.front)||art.images?.[0]; coverUrl=front?.image||""; }
    else { coverUrl=`https://coverartarchive.org/release/${mbid}/front`; }
  }catch{}
  return { title, artist, upc, coverRaw: coverUrl||"", altRaw:"", notes:"", genre:"" };
}

// 13) ADD TO GOOGLE SHEET — strict JSON + detailed errors
async function addRecordToSheet(rec){
  const form=new URLSearchParams({
    title:rec.title||"", artist:rec.artist||"", upc:rec.upc||"",
    genre:rec.genre||"", notes:rec.notes||"",
    cover:rec.coverRaw||"", alt:rec.altRaw||""
  });

  const resp = await fetch(APPS_SCRIPT_URL,{
    method:'POST',
    headers:{ 'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8' },
    body: form.toString()
  });

  let json=null, text="";
  try { json = await resp.clone().json(); } catch { text = await resp.text().catch(()=>"(no body)"); }

  if(!json || !json.ok){
    const snippet = (text || JSON.stringify(json)).slice(0,300).replace(/\s+/g,' ').trim();
    const msg = `Server did not confirm (status ${resp.status}). Response: ${snippet || '(empty)'}`;
    throw new Error(msg);
  }
  return json;
}

// 14) OPTIMISTIC ADD + CONFIRM
async function addToCollection(rec){
  rec.cover = await chooseCover(rec.coverRaw, rec.altRaw);
  state.all.unshift(rec); state.filtered=[...state.all]; applySort(); render();
  return await addRecordToSheet(rec);
}

// 15) SCANNING — mobile-friendly (ZXing fallback)
async function loadZXing(){
  // Try ESM first, fallback to UMD global for older Safari
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

  // Prefer back camera
  const constraints = {
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 }, height: { ideal: 720 }
    },
    audio: false
  };

  return new Promise((resolve, reject)=>{
    reader.decodeFromConstraints(constraints, els.scanVideo, async (result, err, controls)=>{
      if (controls && !state.zxingControls) state.zxingControls = controls;

      if (result && !state.handlingUPC) {
        state.handlingUPC = true;
        try {
          await handleUPC(result.getText());
        } finally {
          resolve(); // we got a code; resolve the promise
        }
      } else if (err && !(err && err.name === 'NotFoundException')) {
        // Real error (camera denied, etc.)
        reject(err);
      }
    });
  });
}

// BarcodeDetector path (desktop where supported)
async function startBDCamera(){
  const constraints={ video:{ facingMode:{ ideal:'environment' }, width:{ ideal:1280 }, height:{ ideal:720 } }, audio:false };
  state.mediaStream=await navigator.mediaDevices.getUserMedia(constraints);
  els.scanVideo.srcObject=state.mediaStream; await els.scanVideo.play();

  if(!state.detector){
    try { state.detector=new window.BarcodeDetector({ formats:['ean_13','ean_8','upc_a','upc_e','code_128','code_39'] }); }
    catch { state.detector=new window.BarcodeDetector(); }
  }

  state.scanning = true;
  els.scanHint.textContent = 'Point your camera at the barcode.';
  scanLoop();
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
  // Mobile: prefer ZXing immediately; Desktop with BD: try BD first
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  try{
    if (isMobile || !state.detectorSupported) {
      els.scanHint.textContent = 'Scanning...';
      await startZXing();
    } else {
      await startBDCamera();
      // Safety: if BD doesn’t find anything soon, fall back to ZXing
      setTimeout(async ()=>{
        if (!state.handlingUPC && !state.usingZXing && els.scanModal.open) {
          console.warn('Falling back to ZXing after BD warmup timeout.');
          await stopScanEngines();
          els.scanHint.textContent = 'Scanning...';
          await startZXing();
        }
      }, 4000);
    }
  }catch(err){
    console.error('Start scan error', err);
    // Final fallback: try ZXing if BD path failed
    if (!state.usingZXing) {
      try {
        els.scanHint.textContent = 'Scanning...';
        await startZXing();
      } catch (e2) {
        console.error('ZXing also failed', e2);
        els.scanStatus.textContent='Camera started, but live scan not available. Use “Enter UPC manually.”';
      }
    } else {
      els.scanStatus.textContent='Live scan not available. Use “Enter UPC manually.”';
    }
  }
}

async function stopScanEngines(){
  // Stop BD loop + camera
  state.scanning=false;
  if(state.rafId) cancelAnimationFrame(state.rafId);
  if(state.mediaStream){ for(const t of state.mediaStream.getTracks()){ t.stop(); } state.mediaStream=null; }
  els.scanVideo.pause(); els.scanVideo.srcObject=null;

  // Stop ZXing controls
  if (state.zxingControls) { try { state.zxingControls.stop(); } catch{} state.zxingControls = null; }
  if (state.zxingReader) { try { state.zxingReader.reset(); } catch{} state.zxingReader = null; }
  state.usingZXing = false;
}

// 16) OPEN/CLOSE MODAL
async function openScanModal(){
  els.scanStatus.textContent=''; state.pending=null; els.scanForm.reset(); els.formUPC.value=""; els.saveRecord.disabled=true;
  els.scanModal.showModal();
  try{
    els.scanHint.textContent='Starting camera…';
    await startScanEngine();
  }catch(e){
    console.error(e);
    els.scanStatus.textContent='Camera unavailable. Use “Enter UPC manually.”';
  }
}
function closeScanModal(){
  stopScanEngines(); els.scanModal.close();
}

// Events
els.scanBtn.addEventListener('click',openScanModal);
els.closeScan?.addEventListener('click',closeScanModal);
els.manualUPC.addEventListener('click',async ()=>{
  const upc=prompt("Enter UPC (numbers only):")||""; const trimmed=upc.replace(/\D+/g,'').trim();
  if(!trimmed){ els.scanStatus.textContent='No UPC entered.'; return; }
  // If user enters manually while engines running, stop them
  await stopScanEngines();
  await handleUPC(trimmed);
});

// 17) After-detect flow
async function handleUPC(upc){
  // Stop any scanning immediately so we don’t double-handle
  await stopScanEngines();
  els.scanStatus.textContent=`UPC: ${upc} — looking up…`;
  try{
    const rec=await lookupByUPC(upc); state.pending=rec;
    els.formUPC.value=rec.upc||upc; els.formArtist.value=rec.artist||""; els.formTitle.value=rec.title||"";
    els.formGenre.value=rec.genre||""; els.formNotes.value=""; els.saveRecord.disabled=false;
    els.scanStatus.textContent=`Found: ${rec.artist || '(unknown)'} — ${rec.title || '(unknown)'} • review & Save`;
    els.formArtist.focus();
  }catch(e){
    console.error(e);
    state.pending={ upc, title:"", artist:"", genre:"", notes:"", coverRaw:"", altRaw:"" };
    els.formUPC.value=upc; els.formArtist.value=""; els.formTitle.value=""; els.formGenre.value=""; els.formNotes.value="";
    els.saveRecord.disabled=false; els.scanStatus.textContent=`No match found. Enter details and Save.`; els.formArtist.focus();
  } finally {
    state.handlingUPC = false; // allow rescans if user reopens
  }
}

// 18) Submit form → save to sheet
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

  els.saveRecord.disabled=true; els.scanStatus.textContent="Saving…";
  try{
    const server = await addToCollection(rec);
    els.scanStatus.textContent = `Saved to "${server.sheet}" (row ${server.row})`;
    setTimeout(()=> closeScanModal(), 900);
  }catch(err){
    console.error(err);
    els.scanStatus.textContent = "Saved locally. " + err.message;
  } finally {
    els.saveRecord.disabled=false;
  }
});

// 19) KICKOFF
loadFromSheet().catch(err=>{
  console.error(err);
  alert("Couldn’t load the Google Sheet. Make sure your link is published as CSV (output=csv).");
});
