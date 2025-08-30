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
