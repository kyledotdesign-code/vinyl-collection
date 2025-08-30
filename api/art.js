// /api/art.js
// Robust serverless artwork resolver for: Apple Music (album or artist page),
// Wikipedia pages, direct image URLs, and iTunes Search fallback.
// Returns JSON: { cover, genre }

export default async function handler(req, res) {
  try {
    const { artist = "", title = "", cover = "" } = req.query;

    // CORS + edge caching
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");

    const looksLikeImage = (u) => /\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(u || "");
    const wsrv = (u) => {
      if (!u) return "";
      const noProto = u.replace(/^https?:\/\//i, "");
      return `https://wsrv.nl/?url=${encodeURIComponent("ssl:" + noProto)}&w=1000&h=1000&fit=cover&output=webp&q=85`;
    };
    const UA = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    };

    // 1) Direct image URL from sheet
    if (looksLikeImage(cover)) {
      return res.status(200).json({ cover: wsrv(cover), genre: "" });
    }

    // 2) Apple Music page (album OR artist)
    if (/https?:\/\/(music|itunes)\.apple\.com\//i.test(cover)) {
      const html = await fetch(cover, UA).then((r) => (r.ok ? r.text() : ""));
      let img = "";

      if (html) {
        // a) Open Graph
        let m =
          html.match(/property=["']og:image(?::secure_url|:url)?["']\s+content=["']([^"']+)["']/i) ||
          html.match(/name=["']twitter:image(?::src)?["']\s+content=["']([^"']+)["']/i);
        if (m && m[1]) img = m[1];

        // b) Common Apple JSON blobs
        if (!img) {
          const j1 = html.match(/"artworkUrl"\s*:\s*"([^"]+)"/i);
          const j2 = html.match(/"artwork"\s*:\s*{[^}]*"url"\s*:\s*"([^"]+)"/i);
          img = (j1 && j1[1]) || (j2 && j2[1]) || "";
        }

        // c) As a last resort, any mzstatic thumb
        if (!img) {
          const any = html.match(/https?:\/\/[^"']+mzstatic\.com\/image\/thumb\/[^"']+\.(?:jpg|png|webp)/i);
          if (any) img = any[0];
        }
      }

      return res.status(200).json({ cover: img ? wsrv(img) : "", genre: "" });
    }

    // 3) Wikipedia page → lead image
    if (/https?:\/\/(?:\w+\.)?wikipedia\.org\/wiki\//i.test(cover)) {
      const titleFromUrl = decodeURIComponent(cover.split("/wiki/")[1] || "").split(/[?#]/)[0];
      const api = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(titleFromUrl)}`;
      const j = await fetch(api, UA).then((r) => (r.ok ? r.json() : null));
      const src = j?.originalimage?.source || j?.thumbnail?.source || "";
      return res.status(200).json({ cover: src ? wsrv(src) : "", genre: "" });
    }

    // 4) Fallback: Apple iTunes Search (server-side avoids browser 403)
    if (artist || title) {
      const term = [artist, title].filter(Boolean).join(" ");
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&limit=1`;
      const data = await fetch(url, UA).then((r) => (r.ok ? r.json() : null));
      if (data?.results?.length) {
        const r0 = data.results[0];
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
