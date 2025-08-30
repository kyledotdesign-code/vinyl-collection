function openStats(){
  const s = buildStats(state.filtered);
  const body = document.querySelector('#statsBody'); body.innerHTML='';

  // Summary tiles: Total Albums, Unique Artists, Total Genres
  const totalGenres = s.topGenres.reduce((sum, [,n])=>sum+n, 0) ? s.topGenres.length : 0;
  const grid = document.createElement('div'); grid.className='stat-grid';
  grid.innerHTML = `
    <div class="stat-tile"><div>Total Albums</div><div class="stat-big">${s.total}</div></div>
    <div class="stat-tile"><div>Unique Artists</div><div class="stat-big">${s.uniqArtists}</div></div>
    <div class="stat-tile"><div>Total Genres</div><div class="stat-big">${totalGenres}</div></div>
  `;
  body.appendChild(grid);

  if (s.topArtists.length){
    const h = document.createElement('h3'); h.textContent='Top Artists'; body.appendChild(h);
    const ul = document.createElement('ul'); ul.style.listStyle='none'; ul.style.padding=0;
    s.topArtists.forEach(([name,n])=>{
      const li=document.createElement('li'); li.textContent=`${name} — ${n}`; ul.appendChild(li);
    });
    body.appendChild(ul);
  }

  if (s.topGenres.length){
    const h = document.createElement('h3'); h.textContent='Top Genres'; body.appendChild(h);
    const chips = document.createElement('div'); chips.className='chips';
    s.topGenres.forEach(([g,n])=>{
      const c=document.createElement('span'); c.className='chip'; c.textContent=`${g} • ${n}`; chips.appendChild(c);
    });
    body.appendChild(chips);
  } else {
    const p=document.createElement('p'); p.textContent='No genres found. Add a "Genre" column in the sheet to see genre stats.'; body.appendChild(p);
  }

  document.querySelector('#statsModal').showModal();
}
// app.js
const SHEET_CSV =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?output=csv";



async function safeFetchCSV(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();

    // Heuristic: if it came back HTML (edit link), show a message.
    if (text.trim().startsWith("<")) {
      showStatus("Your Google Sheet link is not a CSV. Publish to the web and use the CSV link (ends with output=csv).");
      return "";
    }
    return text;
  } catch (e) {
    showStatus("Couldn’t load your Google Sheet. Check the URL or try again.");
    console.error(e);
    return "";
  }
}

function showStatus(msg) {
  let el = document.getElementById("status");
  if (!el) {
    el = document.createElement("div");
    el.id = "status";
    el.style.cssText =
      "margin:24px; padding:14px 16px; border:1px solid #1b2436; background:#0f1727; color:#eef2f8; border-radius:12px; max-width:720px";
    document.querySelector("main")?.prepend(el);
  }
  el.textContent = msg;
}

// Example usage in your loader:
(async () => {
  const csv = await safeFetchCSV(SHEET_CSV);
  if (!csv) return; // bail with message already shown
  // ...parse CSV and render as before
})();
