/**
 * Vercel Edge Function — /api/news
 *
 * Fetches 7 RSS feeds in parallel (India power sector focus) and returns
 * a merged RSS envelope for the frontend to parse with DOMParser.
 *
 * NOTE: Edge runtime has no DOMParser — item extraction uses string matching.
 * Handles both RSS (<item>) and Atom (<entry>) formats.
 *
 * Vercel caches 30 min at edge (s-maxage=1800).
 */

export const config = { runtime: "edge" };

const GN = (q: string) =>
  "https://news.google.com/rss/search?q=" +
  encodeURIComponent(q) +
  "&hl=en-IN&gl=IN&ceid=IN:en";

const FEEDS = [
  // Google News queries — India-targeted (broad)
  GN("India power electricity sector coal discom grid demand generation"),
  GN("India solar wind renewable energy NTPC IEX RTM DAM tariff capacity"),
  GN("India peak demand power shortage thermal hydro PLF generation"),
  // Google News queries — targeted (surfaces ET Energy & high-quality power articles)
  GN("India 270 GW peak demand power minister summer 2026"),
  GN("India electricity tariff RTM DAM IEX power purchase coal stock"),

  // Indian energy publications with working RSS
  "https://mercomindia.com/feed/",
  "https://www.business-standard.com/rss/power-sector-12.rss",
  "https://powerline.net.in/feed/",
];

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; RSS-reader/1.0)",
  Accept: "application/rss+xml, application/xml, text/xml, */*",
};

/** Extract all <item> or <entry> blocks from an XML/Atom string, normalising to <item> */
function extractItems(xml: string): string {
  // Standard RSS <item>
  const rssItems = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);

  // Atom <entry> — convert to <item> so frontend parser handles it uniformly
  const atomItems = [...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)].map((m) => {
    const entry = m[0];
    // Extract key fields
    const title = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
    const link =
      entry.match(/<link[^>]+href="([^"]+)"/i)?.[1] ??
      entry.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] ?? "";
    const pubDate =
      entry.match(/<published>([\s\S]*?)<\/published>/i)?.[1] ??
      entry.match(/<updated>([\s\S]*?)<\/updated>/i)?.[1] ?? "";
    const summary =
      entry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1] ??
      entry.match(/<content[^>]*>([\s\S]*?)<\/content>/i)?.[1] ?? "";
    const source = entry.match(/<author[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/i)?.[1] ?? "";
    return `<item><title>${title}</title><link>${link}</link><pubDate>${pubDate}</pubDate><source>${source}</source><description>${summary}</description></item>`;
  });

  return [...rssItems, ...atomItems].join("\n");
}

export default async function handler(): Promise<Response> {
  const results = await Promise.allSettled(
    FEEDS.map((url) =>
      fetch(url, { headers: FETCH_HEADERS }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
    )
  );

  const succeeded = results.filter(
    (r): r is PromiseFulfilledResult<string> => r.status === "fulfilled"
  );

  const allItems = succeeded.map((r) => extractItems(r.value)).join("\n");

  if (!allItems.trim()) {
    return new Response("No items found across all feeds", { status: 502 });
  }

  const combined = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>India Power News</title>${allItems}</channel></rss>`;

  return new Response(combined, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "s-maxage=1800, stale-while-revalidate=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
