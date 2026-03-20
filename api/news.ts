/**
 * Vercel Edge Function — /api/news
 *
 * Fetches 4 RSS feeds in parallel (2 Google News queries + ET Energy + Mercom India),
 * merges all <item> blocks, and returns a single RSS envelope for the frontend to parse.
 *
 * NOTE: Edge runtime does NOT have DOMParser — item extraction uses string matching.
 *
 * Vercel caches the response for 30 min at the edge (s-maxage=1800).
 */

export const config = { runtime: "edge" };

const FEEDS = [
  // Google News — broad India power sector query
  "https://news.google.com/rss/search?q=" +
    encodeURIComponent(
      "India power electricity sector coal discom grid demand generation"
    ) +
    "&hl=en-IN&gl=IN&ceid=IN:en",

  // Google News — specific technologies & market terms
  "https://news.google.com/rss/search?q=" +
    encodeURIComponent(
      "India solar wind renewable NTPC IEX RTM DAM generation energy tariff"
    ) +
    "&hl=en-IN&gl=IN&ceid=IN:en",

  // Economic Times — Energy section (India-specific, always relevant)
  "https://economictimes.indiatimes.com/industry/energy/rss",

  // Mercom India — renewable energy / solar focus
  "https://mercomindia.com/feed/",
];

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; RSS-reader/1.0)",
  Accept: "application/rss+xml, application/xml, text/xml, */*",
};

/** Extract all <item>…</item> blocks from an XML string */
function extractItems(xml: string): string {
  const matches = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)];
  return matches.map((m) => m[0]).join("\n");
}

export default async function handler(): Promise<Response> {
  // Fetch all feeds in parallel; individual failures are tolerated
  const results = await Promise.allSettled(
    FEEDS.map((url) =>
      fetch(url, { headers: FETCH_HEADERS }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
    )
  );

  const allItems = results
    .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
    .map((r) => extractItems(r.value))
    .join("\n");

  if (!allItems.includes("<item")) {
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
