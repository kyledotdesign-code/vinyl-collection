// /api/art.js
// Serverless artwork resolver: Apple Music pages, Wikipedia pages, direct images, plus Apple Search fallback.

export default async function handler(req, res) {
  try {
    const { artist = "", title = "", cover = "" } = req.query;

    // CORS + edge caching
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");

    // Helpers
    const wsrv = (u) => {
      if (!u) return "";
      const noProto = u.replace(/^https?:\/\//i, "");
      return `https://wsrv.nl/?url=${encodeURIComponent("ssl:" + noProto)}&w=1000&h=1000&fit=cover&output=webp&q=85`;
    };
    const looksLikeImage = (u) => /\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(u || "");
    const UA = {
      headers: {
        // Some sites (incl. Apple) prefer a browsery UA
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    };

    // ---- 1) If the sheet gave us a direct image URL, just proxy/resize it.
    if (looksLikeImage(cover)) {
      return res.status(200).json({ cover: wsrv(cover), genre: "" });
    }

    // ---- 2) Apple Music page (album OR artist)
    if (/https?:\/\/(music|itunes)\.apple\.com\//i.test(cover)) {
      const html = await fetch(cover, UA).then((r) => (r.ok ? r.text() : ""));
      let img = "";
      if (html) {
        // Try secure og:image first
        let m =
          html.match(/property=["']og:image:secure_url["']\s+content=["']([^"']+)["']/i) ||
          html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i);
        if (m && m[1]) img = m[1];

        // Sometimes Apple embeds artwork URLs in JSON blobs as "artwork" / "artworkUrl"
        if (!img) {
          const jsonMatches = html.match(/"artworkUrl"[^"]*"([^"]+)"/i) || html.match(/"artwork"[^}]*"url"[^"]*"([^"]+)"/i);
          if (jsonMatches && jsonMatches[1]) img = jsonMatches[1];
        }
      }
      return res.status(200).json({ cover: img ? wsrv(img) : "", genre: "" });
    }

    // ---- 3) Wikipedia page → lead image
    if (/https?:\/\/(?:\w+\.)?wikipedia\.org\/wiki\//i.test(cover)) {
      const titleFromUrl = decodeURIComponent(cover.split("/wiki/")[1] || "").split(/[?#]/)[0];
      const api = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(titleFromUrl)}`;
      const j = await fetch(api, UA).then((r) => (r.ok ? r.json() : null));
      const src = j?.originalimage?.source || j?.thumbnail?.source || "";
      return res.status(200).json({ cover: src ? wsrv(src) : "", genre: "" });
    }

    // ---- 4) Fallback: Apple iTunes Search (server-side to avoid 403 in browser)
    if (artist || title) {
      const term = [artist, title].filter(Boolean).join(" ");
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&limit=1`;
      const data = await fetch(url, UA).then((r) => (r.ok ? r.json() : null));
      if (data?.results?.length) {
        const r0 = data.results[0];
        // Upscale artwork to 1000x1000
        const art = (r0.artworkUrl100 || "").replace(/\/[\d]+x[\d]+bb\.(jpg|png)/i, "/1000x1000bb.$1");
        const genre = r0.primaryGenreName || "";
        return res.status(200).json({ cover: art ? wsrv(art) : "", genre });
      }
    }

    // Nothing found
    return res.status(200).json({ cover: "", genre: "" });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ cover: "", genre: "" });
  }
}
