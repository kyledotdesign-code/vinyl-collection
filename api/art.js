// api/art.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");

  const artist = (req.query.artist || "").toString().trim();
  const title  = (req.query.title  || "").toString().trim();
  const coverHint = (req.query.cover || "").toString().trim();

  const looksLikeImage = u => /\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(u || "");
  const wsrv = (url) => {
    if (!url) return "";
    const u = url.replace(/^https?:\/\//, "");
    return `https://wsrv.nl/?url=${encodeURIComponent("ssl:" + u)}&w=1000&h=1000&fit=cover&output=webp&q=85`;
  };

  async function fromWikipediaPage(url) {
    const m = url.match(/https?:\/\/(?:\w+\.)?wikipedia\.org\/wiki\/([^?#]+)/i);
    if (!m) return "";
    const page = decodeURIComponent(m[1]);
    try {
      const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page)}`);
      if (!r.ok) return "";
      const j = await r.json();
      const src = j?.originalimage?.source || j?.thumbnail?.source || "";
      return src ? wsrv(src) : "";
    } catch { return ""; }
  }

  async function fromApple(artist, title) {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${title}`)}&entity=album&limit=1`;
    try {
      const r = await fetch(url, { headers: { "User-Agent": "vinyl-collection/1.0 (+vercel)" } });
      if (!r.ok) return {};
      const j = await r.json();
      if (j.resultCount > 0) {
        const it = j.results[0];
        const art = it.artworkUrl100?.replace(/100x100bb\.(?:jpg|png)/, "1000x1000bb.jpg") || "";
        return { cover: art ? wsrv(art) : "", genre: it.primaryGenreName || "", source: "apple" };
      }
    } catch {}
    return {};
  }

  async function fromDeezer(artist, title) {
    const q = `artist:"${artist}" album:"${title}"`;
    try {
      const r = await fetch(`https://api.deezer.com/search/album?q=${encodeURIComponent(q)}`);
      if (!r.ok) return {};
      const j = await r.json();
      const it = j?.data?.[0];
      if (!it) return {};
      const art = it.cover_xl || it.cover_big || it.cover_medium || it.cover || "";
      return { cover: art ? wsrv(art) : "", genre: "", source: "deezer" };
    } catch {}
    return {};
  }

  async function fromWikipediaSearch(artist, title) {
    const q = `${title} ${artist} album`;
    try {
      const s = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json`);
      if (!s.ok) return {};
      const sj = await s.json();
      const first = sj?.query?.search?.[0]?.title;
      if (!first) return {};
      const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(first)}`);
      if (!r.ok) return {};
      const j = await r.json();
      const src = j?.originalimage?.source || j?.thumbnail?.source || "";
      return { cover: src ? wsrv(src) : "", genre: "", source: "wikipedia" };
    } catch {}
    return {};
  }

  // 1) Sheet cover hint first
  if (coverHint) {
    if (looksLikeImage(coverHint)) {
      return res.status(200).json({ cover: wsrv(coverHint), genre: "", source: "sheet" });
    }
    if (/wikipedia\.org\/wiki\//i.test(coverHint)) {
      const c = await fromWikipediaPage(coverHint);
      if (c) return res.status(200).json({ cover: c, genre: "", source: "wikipedia" });
    }
  }

  // 2) Apple
  const a = await fromApple(artist, title);
  if (a?.cover) return res.status(200).json(a);

  // 3) Deezer fallback
  const d = await fromDeezer(artist, title);
  if (d?.cover) return res.status(200).json(d);

  // 4) Wikipedia search fallback
  const w = await fromWikipediaSearch(artist, title);
  if (w?.cover) return res.status(200).json(w);

  return res.status(200).json({ cover: "", genre: "", source: "none" });
}
