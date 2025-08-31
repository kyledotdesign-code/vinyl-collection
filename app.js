/* =========================================================
   Vinyl Collection — app.js (drop-in, full file)
   - Loads your Google Sheet (CSV)
   - Renders Scroll & Grid views w/ flips
   - Search, Sort, Shuffle, Stats
   - UPC Scanner → auto-fill via Apps Script (MusicBrainz/Discogs)
   - Resolves cover art from Sheet "Album Artwork" or "Alt Artwork"
   - Fast first render + async art hydration
   ---------------------------------------------------------
   Sheet CSV:
   https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?output=csv

   Apps Script URL (provided):
   https://script.google.com/macros/s/AKfycbwpf5emXEyiy-vTaq7bnZzOzC7TxFSy53XqO9mId1wTSze0m-KLxyrbnWRT0xohwK4TRg/exec
   ========================================================= */

(() => {
  // ---------- 0) CONFIG ----------
  const SHEET_CSV =
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ7Jiw68O2JXlYMFddNYg7z622NoOjJ0Iz6A0yWT6afvrftLnc-OrN7loKD2W7t7PDbqrJpzLjtKDu/pub?output=csv";

  // Apps Script endpoint (for appending rows + UPC lookup)
  const APP_SCRIPT_URL =
    window.APP_SCRIPT_URL ||
    "https://script.google.com/macros/s/AKfycbwpf5emXEyiy-vTaq7bnZzOzC7TxFSy53XqO9mId1wTSze0m-KLxyrbnWRT0xohwK4TRg/exec";

  // CSV header synonyms so we can be forgiving
  const HEADER_ALIASES = {
    title: ["title", "album", "record", "release", "album name"],
    artist: ["artist", "artists", "band"],
    genre: ["genre", "genres", "style", "category"],
    notes: ["notes", "special notes", "comment", "comments", "description"],
    cover: [
      "album artwork",
      "artwork",
      "cover",
      "cover url",
      "image",
      "art",
      "art url",
      "artwork url"
    ],
    alt: ["alt artwork", "alt art", "alt image", "alternate artwork"]
  };

  // Simple inline placeholder (subtle spinner on dark)
  const PLACEHOLDER =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
        <defs>
          <radialGradient id="g" cx="50%" cy="50%" r="60%">
            <stop offset="0%" stop-color="#1a2437"/>
            <stop offset="100%" stop-color="#0b111d"/>
          </radialGradient>
        </defs>
        <rect width="120" height="120" fill="url(#g)"/>
        <circle cx="60" cy="60" r="32" fill="none" stroke="#3b4b6e" stroke-width="6" opacity="0.55"/>
        <circle cx="60" cy="60" r="32" fill="none" stroke="#a8b5e8" stroke-width="6" stroke-dasharray="70 200">
          <animateTransform attributeName="transform" type="rotate" dur="1s" repeatCount="indefinite" from="0 60 60" to="360 60 60"/>
        </circle>
      </svg>`
    );

  // ---------- 1) DOM ----------
  const $ = (s, r = document) => r.querySelector(s);
  const els = {
    search: $("#search"),
    viewScroll: $("#view-scroll"),
    viewGrid: $("#view-grid"),
    sort: $("#sort"),
    shuffle: $("#shuffle"),
    sheetLink: $("#sheetLink"),
    statsBtn: $("#statsBtn"),
    scrollView: $("#scrollView"),
    gridView: $("#gridView"),
    scroller: $("#scroller"),
    grid: $("#grid"),
    prev: $("#scrollPrev"),
    next: $("#scrollNext"),
    statsModal: $("#statsModal"),
    statsBody: $("#statsBody"),
    cardTpl: $("#cardTpl")
  };

  // ---------- 2) STATE ----------
  const state = {
    all: /** @type {Record[]} */ ([]),
    filtered: [],
    view: "scroll", // 'scroll' | 'grid'
    sortKey: "title" // 'title' | 'artist'
  };
  // expose so scanner can insert new row optimistically
  window.state = state;

  // ---------- 3) CSV LOADING ----------
  function looksLikeImage(u) {
    return /\.(png|jpe?g|gif|webp|avif|jfif|bmp)(\?|#|$)/i.test(u || "");
  }
  function isWikipediaPage(u) {
    return /https?:\/\/[^/]*wikipedia\.org\/wiki\//i.test(u || "");
  }
  function pick(obj, synonyms) {
    const keys = Object.keys(obj || {});
    for (const name of synonyms) {
      const hit = keys.find((k) => k.trim().toLowerCase() === name);
      if (hit) {
        const v = String(obj[hit] ?? "").trim();
        if (v) return v;
      }
    }
    return "";
  }

  async function loadFromSheet() {
    // Fetch CSV text (cache-bust so updates show quickly)
    const res = await fetch(SHEET_CSV + "&t=" + Date.now(), {
      cache: "no-store"
    });
    const text = await res.text();

    // Parse via Papa
    const parsed = Papa.parse(text, {
      header: true,
      skipEmptyLines: true
    });

    // Normalize rows -> our record shape
    /** @type {Record[]} */
    const rows = (parsed.data || []).map((r) => {
      const title = pick(r, HEADER_ALIASES.title);
      const artist = pick(r, HEADER_ALIASES.artist);
      const genre = pick(r, HEADER_ALIASES.genre);
      const notes = pick(r, HEADER_ALIASES.notes);
      const coverRaw = pick(r, HEADER_ALIASES.cover);
      const altRaw = pick(r, HEADER_ALIASES.alt);
      return {
        title,
        artist,
        genre,
        notes,
        coverRaw,
        altRaw,
        cover: "" // will be hydrated
      };
    });

    state.all = rows.filter((x) => x.title || x.artist);
    state.filtered = [...state.all];
    applySort();
    render(); // fast first paint with placeholders

    // Hydrate covers in background with limited concurrency
    hydrateCovers(state.all, 8).catch(console.warn);
  }

  // ---------- 4) COVER RESOLUTION ----------
  async function fromWikipediaPage(pageUrl) {
    const m = pageUrl.match(
      /https?:\/\/(?:\w+\.)?wikipedia\.org\/wiki\/([^?#]+)/i
    );
    if (!m) return "";
    const title = decodeURIComponent(m[1]);
    try {
      const r = await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
          title
        )}`
      );
      if (!r.ok) return "";
      const j = await r.json();
      const src = j?.originalimage?.source || j?.thumbnail?.source || "";
      return src || "";
    } catch {
      return "";
    }
  }

  async function pickCoverURL(rec) {
    // Prefer primary
    let candidates = [rec.coverRaw, rec.altRaw].filter(Boolean);

    for (const url of candidates) {
      if (!url) continue;

      // direct image?
      if (looksLikeImage(url)) {
        return url;
      }
      // Wikipedia page → image
      if (isWikipediaPage(url)) {
        const img = await fromWikipediaPage(url);
        if (img) return img;
      }
      // Otherwise, leave for now (could add more resolvers later)
    }
    return ""; // nothing usable
  }

  async function hydrateCovers(list, concurrency = 6) {
    let i = 0;
    async function worker() {
      while (i < list.length) {
        const idx = i++;
        const rec = list[idx];
        if (!rec) continue;

        try {
          const url = await pickCoverURL(rec);
          if (url) {
            rec.cover = url;
            updateCardCover(idx, url);
          } else {
            // keep placeholder
          }
        } catch (e) {
          // keep placeholder
          console.debug("cover error", e);
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  function updateCardCover(idx, url) {
    // Try in scroll view
    const cardA = els.scroller?.querySelector(`.card[data-idx="${idx}"]`);
    const imgA = cardA?.querySelector("img.cover");
    if (imgA && url) {
      safeSetImg(imgA, url);
    }
    // Try in grid view
    const cardB = els.grid?.querySelector(`.card[data-idx="${idx}"]`);
    const imgB = cardB?.querySelector("img.cover");
    if (imgB && url) {
      safeSetImg(imgB, url);
    }
  }

  function safeSetImg(img, url) {
    // apply src and add onerror fallback to placeholder
    img.onerror = () => {
      img.onerror = null;
      img.src = PLACEHOLDER;
    };
    img.src = url;
  }

  // ---------- 5) RENDER ----------
  function createCard(rec, idx) {
    const tpl = els.cardTpl?.content;
    if (!tpl) return document.createElement("div");

    const node = tpl.cloneNode(true);
    const root = node.querySelector(".card");
    const img = node.querySelector("img.cover");
    const titleEl = node.querySelector(".title");
    const artistEl = node.querySelector(".artist");
    const genreEl = node.querySelector(".genre");
    const capTitle = node.querySelector(".caption-title");
    const capArtist = node.querySelector(".caption-artist");

    if (root) root.dataset.idx = String(idx);

    const title = rec.title || "Untitled";
    const artist = rec.artist || "Unknown Artist";
    const genre = rec.genre || "";

    if (img) {
      img.alt = `${title} — ${artist}`;
      img.src = PLACEHOLDER; // quick placeholder
      if (rec.cover) {
        safeSetImg(img, rec.cover);
      } else if (rec.coverRaw || rec.altRaw) {
        // cover will be hydrated async; keep placeholder for now
      }
    }
    if (titleEl) titleEl.textContent = title;
    if (artistEl) artistEl.textContent = artist;
    if (genreEl) {
      genreEl.textContent = genre ? `Genre: ${genre}` : "";
      if (!genre) genreEl.style.display = "none";
    }
    if (capTitle) capTitle.textContent = title;
    if (capArtist) capArtist.textContent = artist;

    return node;
  }

  function bindFlips(container) {
    container?.addEventListener("click", (e) => {
      const card = e.target.closest(".card");
      if (!card) return;
      card.classList.toggle("flipped");
    });
  }

  function renderScroll() {
    if (!els.scroller) return;
    els.scroller.innerHTML = "";
    const frag = document.createDocumentFragment();
    state.filtered.forEach((r, i) => {
      frag.appendChild(createCard(r, i));
    });
    els.scroller.appendChild(frag);
    els.scroller.scrollLeft = 0; // start at first item
  }

  function renderGrid() {
    if (!els.grid) return;
    els.grid.innerHTML = "";
    const frag = document.createDocumentFragment();
    state.filtered.forEach((r, i) => {
      frag.appendChild(createCard(r, i));
    });
    els.grid.appendChild(frag);
  }

  function render() {
    if (state.view === "scroll") {
      els.scrollView?.classList.add("active");
      els.gridView?.classList.remove("active");
      renderScroll();
      toggleArrows(true);
    } else {
      els.gridView?.classList.add("active");
      els.scrollView?.classList.remove("active");
      renderGrid();
      toggleArrows(false);
    }
  }

  // ---------- 6) SEARCH / SORT / SHUFFLE ----------
  function applySort() {
    const k = state.sortKey;
    state.filtered.sort((a, b) => {
      const A = (a[k] || "").toLowerCase();
      const B = (b[k] || "").toLowerCase();
      return A.localeCompare(B);
    });
  }

  els.search?.addEventListener("input", (e) => {
    const q = String(e.target.value || "").trim().toLowerCase();
    state.filtered = state.all.filter((r) => {
      const hay = `${r.title} ${r.artist} ${r.genre} ${r.notes}`.toLowerCase();
      return hay.includes(q);
    });
    applySort();
    render();
  });

  els.sort?.addEventListener("change", () => {
    const v = els.sort.value === "artist" ? "artist" : "title";
    state.sortKey = v;
    applySort();
    render();
  });

  els.shuffle?.addEventListener("click", () => {
    for (let i = state.filtered.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.filtered[i], state.filtered[j]] = [
        state.filtered[j],
        state.filtered[i]
      ];
    }
    render();
  });

  // ---------- 7) VIEW TOGGLES ----------
  function toggleArrows(show) {
    if (els.prev) els.prev.style.display = show ? "" : "none";
    if (els.next) els.next.style.display = show ? "" : "none";
  }
  els.viewScroll?.addEventListener("click", () => {
    state.view = "scroll";
    els.viewScroll.classList.add("active");
    els.viewGrid?.classList.remove("active");
    render();
  });
  els.viewGrid?.addEventListener("click", () => {
    state.view = "grid";
    els.viewGrid.classList.add("active");
    els.viewScroll?.classList.remove("active");
    render();
  });

  // Scroll arrows
  els.prev?.addEventListener("click", () => {
    if (!els.scroller) return;
    els.scroller.scrollBy({
      left: -Math.round(els.scroller.clientWidth * 0.9),
      behavior: "smooth"
    });
  });
  els.next?.addEventListener("click", () => {
    if (!els.scroller) return;
    els.scroller.scrollBy({
      left: Math.round(els.scroller.clientWidth * 0.9),
      behavior: "smooth"
    });
  });

  // Enable flips in both views
  bindFlips(els.scroller);
  bindFlips(els.grid);

  // ---------- 8) STATS ----------
  function buildStats(recs) {
    const total = recs.length;
    const byArtist = new Map();
    const byGenre = new Map();
    for (const r of recs) {
      if (r.artist) byArtist.set(r.artist, (byArtist.get(r.artist) || 0) + 1);
      if (r.genre) {
        String(r.genre)
          .split(/[\/,&]| and /i)
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((g) => byGenre.set(g, (byGenre.get(g) || 0) + 1));
      }
    }
    const topArtists = [...byArtist.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
    const topGenres = [...byGenre.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
    return {
      total,
      uniqArtists: byArtist.size,
      topArtists,
      topGenres
    };
  }

  function openStats() {
    if (!els.statsBody || !els.statsModal) return;
    const s = buildStats(state.filtered);
    const totalGenres = s.topGenres.length;
    els.statsBody.innerHTML = "";

    const grid = document.createElement("div");
    grid.className = "stat-grid";
    grid.innerHTML = `
      <div class="stat-tile"><div>Total Albums</div><div class="stat-big">${s.total}</div></div>
      <div class="stat-tile"><div>Unique Artists</div><div class="stat-big">${s.uniqArtists}</div></div>
      <div class="stat-tile"><div>Total Genres</div><div class="stat-big">${totalGenres}</div></div>
    `;
    els.statsBody.appendChild(grid);

    if (s.topArtists.length) {
      const h = document.createElement("h3");
      h.textContent = "Top Artists";
      els.statsBody.appendChild(h);

      const chips = document.createElement("div");
      chips.className = "chips";
      s.topArtists.forEach(([name, n]) => {
        const c = document.createElement("span");
        c.className = "chip";
        c.textContent = `${name} • ${n}`;
        chips.appendChild(c);
      });
      els.statsBody.appendChild(chips);
    }

    if (s.topGenres.length) {
      const h = document.createElement("h3");
      h.textContent = "Top Genres";
      els.statsBody.appendChild(h);

      const chips = document.createElement("div");
      chips.className = "chips";
      s.topGenres.forEach(([g, n]) => {
        const c = document.createElement("span");
        c.className = "chip";
        c.textContent = `${g} • ${n}`;
        chips.appendChild(c);
      });
      els.statsBody.appendChild(chips);
    }

    // Open dialog
    try {
      els.statsModal.showModal();
    } catch {
      // fallback for browsers without <dialog>
      els.statsModal.setAttribute("open", "true");
    }
  }

  // Bind Stats button (ensure it exists and only one handler)
  els.statsBtn?.addEventListener("click", openStats);

  // Close dialog on backdrop click (optional)
  els.statsModal?.addEventListener("click", (ev) => {
    const rect = ev.target.getBoundingClientRect?.();
    if (!rect) return;
    // if click is outside the inner form/card, close
    if (ev.target === els.statsModal) {
      els.statsModal.close?.();
    }
  });

  // ---------- 9) STARTUP ----------
  loadFromSheet().catch((e) => console.error(e));

  // =========================================================
  // 10) UPC SCANNER BLOCK — uses Apps Script for auto-fill
  //     (Requires Quagga script + the scanner HTML elements in your page)
  // =========================================================
  const scanEls = {
    dialog: document.getElementById("scanDialog"),
    viewport: document.getElementById("scannerViewport"),
    openBtn: document.getElementById("scanBtn"),
    closeBtn: document.getElementById("scanClose"),
    againBtn: document.getElementById("scanAgain"),
    saveBtn: document.getElementById("scanSave"),
    resultWrap: document.getElementById("scanResult"),
    upcText: document.getElementById("upcText"),
    upc: document.getElementById("scanUPC"),
    artist: document.getElementById("scanArtist"),
    title: document.getElementById("scanTitle"),
    notes: document.getElementById("scanNotes"),
    cover: document.getElementById("scanCover")
  };

  let scanning = false;
  let lastDetected = 0;

  function startScanner() {
    if (scanning) return;
    if (!window.Quagga) {
      alert("Scanner not available (Quagga script missing).");
      return;
    }
    scanning = true;
    if (scanEls.resultWrap) scanEls.resultWrap.hidden = true;

    const readers = [
      "upc_reader",
      "upc_e_reader",
      "ean_reader",
      "ean_8_reader"
    ];

    Quagga.init(
      {
        inputStream: {
          type: "LiveStream",
          target: scanEls.viewport,
          constraints: {
            facingMode: "environment",
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        },
        locator: { halfSample: true, patchSize: "medium" },
        decoder: { readers },
        numOfWorkers: navigator.hardwareConcurrency
          ? Math.max(2, navigator.hardwareConcurrency - 1)
          : 2
      },
      (err) => {
        if (err) {
          console.error(err);
          alert("Camera error. Check permissions and try again.");
          scanning = false;
          return;
        }
        Quagga.start();
      }
    );

    Quagga.onDetected(onDetected);
  }

  function stopScanner() {
    try {
      Quagga.offDetected(onDetected);
    } catch {}
    try {
      Quagga.stop();
    } catch {}
    scanning = false;
  }

  async function onDetected(res) {
    const now = Date.now();
    if (now - lastDetected < 1500) return; // debounce 1.5s
    lastDetected = now;

    const code = res?.codeResult?.code || "";
    if (!/^\d{8,14}$/.test(code)) return;

    if (navigator.vibrate) navigator.vibrate([60, 20, 60]);
    stopScanner();

    if (scanEls.upc) scanEls.upc.value = code;
    if (scanEls.upcText) scanEls.upcText.textContent = code;
    if (scanEls.resultWrap) scanEls.resultWrap.hidden = false;

    // Try auto-fill via Apps Script lookup
    try {
      const url = `${APP_SCRIPT_URL}?lookup=1&upc=${encodeURIComponent(code)}`;
      const r = await fetch(url, { cache: "no-store" });
      let data = null;
      if (r.ok) data = await r.json();

      if (data && data.ok) {
        if (data.artist && scanEls.artist) scanEls.artist.value = data.artist;
        if (data.title && scanEls.title) scanEls.title.value = data.title;
        if (data.cover && scanEls.cover) scanEls.cover.value = data.cover;

        const t =
          "(Scanned UPC " + code + (data.source ? " • " + data.source : "") + ")";
        if (scanEls.notes) {
          scanEls.notes.value = scanEls.notes.value
            ? scanEls.notes.value + " " + t
            : t;
        }
      }
    } catch (e) {
      console.warn("UPC lookup failed", e);
    }
  }

  async function saveScanned() {
    const rec = {
      artist: scanEls.artist?.value.trim() || "",
      title: scanEls.title?.value.trim() || "",
      notes: scanEls.notes?.value.trim() || "",
      cover: scanEls.cover?.value.trim() || "",
      upc: scanEls.upc?.value.trim() || ""
    };
    if (!rec.artist || !rec.title) {
      alert("Please fill Artist and Title.");
      return;
    }

    // Optimistic UI insert at top
    const newRec = {
      artist: rec.artist,
      title: rec.title,
      notes: rec.notes,
      genre: "",
      coverRaw: rec.cover,
      altRaw: "",
      cover: rec.cover || ""
    };
    state.all.unshift(newRec);
    state.filtered = [...state.all];
    applySort();
    render();

    // Append to Google Sheet (best-effort)
    if (APP_SCRIPT_URL && APP_SCRIPT_URL.startsWith("http")) {
      try {
        await fetch(APP_SCRIPT_URL, {
          method: "POST",
          mode: "no-cors",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(rec)
        });
      } catch (e) {
        console.warn("Sheet write failed; item still appears locally.", e);
      }
    }

    // Reset scanner form
    if (scanEls.artist) scanEls.artist.value = "";
    if (scanEls.title) scanEls.title.value = "";
    if (scanEls.notes) scanEls.notes.value = "";
    if (scanEls.cover) scanEls.cover.value = "";
    if (scanEls.upc) scanEls.upc.value = "";
    if (scanEls.resultWrap) scanEls.resultWrap.hidden = true;
    scanEls.dialog?.close();
  }

  // Wire up scanner UI if present
  scanEls.openBtn?.addEventListener("click", () => {
    scanEls.dialog?.showModal?.();
    startScanner();
  });
  scanEls.closeBtn?.addEventListener("click", () => {
    scanEls.dialog?.close?.();
    stopScanner();
  });
  scanEls.againBtn?.addEventListener("click", () => {
    if (scanEls.resultWrap) scanEls.resultWrap.hidden = true;
    startScanner();
  });
  scanEls.saveBtn?.addEventListener("click", saveScanned);
})();

/* ---------- TYPES (for reference) ----------
type Record = {
  title: string;
  artist: string;
  genre: string;
  notes: string;
  coverRaw: string;
  altRaw: string;
  cover: string; // resolved
};
-------------------------------------------- */
