/**
 * Vercel Edge Function — /api/news-summary
 *
 * Returns the top 5 India power-sector news articles with real descriptions.
 * No API key required — uses RSS feeds that include genuine article summaries.
 *
 * Strategy:
 *   1. Fetch all feeds in parallel
 *   2. Prioritise ET Energy, Mercom, Business Standard, Power Line (have real descriptions)
 *   3. Fill remaining slots from Google News (title-only; snippet suppressed if it repeats title)
 *   4. Return JSON: { items: Array<{title,url,source,publishedAtISO,summary}> }
 *
 * Cached 30 min at edge (s-maxage=1800).
 */

export const config = { runtime: "edge" };

const GN = (q: string) =>
  "https://news.google.com/rss/search?q=" +
  encodeURIComponent(q) +
  "&hl=en-IN&gl=IN&ceid=IN:en";

// Priority feeds — these include real article descriptions
const PRIORITY_FEEDS = [
  "https://economictimes.indiatimes.com/industry/energy/rss",
  "https://mercomindia.com/feed/",
  "https://www.business-standard.com/rss/power-sector-12.rss",
  "https://powerline.net.in/feed/",
];

// Google News feeds — descriptions are just the title repeated
const GN_FEEDS = [
  GN("India power electricity sector coal discom grid demand generation"),
  GN("India solar wind renewable energy NTPC IEX RTM DAM tariff capacity"),
  GN("India peak demand power shortage thermal hydro PLF generation"),
];

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; RSS-reader/1.0)",
  Accept: "application/rss+xml, application/xml, text/xml, */*",
};

const POWER_TERMS = [
  "power", "electricity", "energy", "coal", "solar", "wind", "rtm", "dam",
  "grid", "demand", "supply", "generation", "thermal", "renewable", "discom",
  "ntpc", "iex", "tariff", "capacity", "plf", "hydro", "nhpc", "genco", "mw", "gw",
];

type Item = {
  title: string;
  url: string;
  source: string;
  publishedAtISO: string;
  summary: string;
  isPriority: boolean; // true = from a real-content feed
};

/** Decode common HTML entities (no DOMParser available in Edge runtime) */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Strip HTML tags then decode entities */
function cleanText(raw: string): string {
  const noTags = raw.replace(/<[^>]+>/g, " ");
  return decodeEntities(noTags).replace(/\s+/g, " ").trim();
}

/** Return true if the snippet is just a repeat of the title (Google News pattern) */
function isJustTitle(snippet: string, title: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const ns = norm(snippet);
  const nt = norm(title.slice(0, 40));
  return nt.length > 10 && ns.includes(nt);
}

/** Extract <item> and <entry> blocks from XML and parse into Item objects */
function parseItems(xml: string, fromIso: string, isPriority: boolean): Item[] {
  const items: Item[] = [];

  // RSS <item>
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const block = m[0];
    const title = cleanText(
      block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1] ?? ""
    );
    const url =
      block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]?.trim() ??
      block.match(/<link[^>]+href="([^"]+)"/i)?.[1] ?? "";
    const pubDateStr =
      block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() ?? "";
    const source = cleanText(
      block.match(/<source[^>]*>([\s\S]*?)<\/source>/i)?.[1] ?? ""
    );
    const rawDesc =
      block.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)?.[1] ?? "";
    const cleaned = cleanText(rawDesc).slice(0, 500);
    const summary = isJustTitle(cleaned, title) ? "" : cleaned;

    const pubDate = new Date(pubDateStr);
    if (!title || !url || isNaN(pubDate.getTime())) continue;
    if (pubDate.toISOString().slice(0, 10) < fromIso) continue;

    const hay = `${title} ${summary} ${source}`.toLowerCase();
    const isNonIndia =
      /\b(china|pakistan|usa|europe|africa|australia|germany|france)\b/.test(hay) &&
      !hay.includes("india") && !hay.includes("indian");
    if (isNonIndia) continue;
    if (!POWER_TERMS.some((t) => hay.includes(t))) continue;

    items.push({ title, url, source, publishedAtISO: pubDate.toISOString(), summary, isPriority });
  }

  // Atom <entry>
  for (const m of xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)) {
    const block = m[0];
    const title = cleanText(
      block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""
    );
    const url =
      block.match(/<link[^>]+href="([^"]+)"/i)?.[1] ??
      block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]?.trim() ?? "";
    const pubDateStr =
      block.match(/<published>([\s\S]*?)<\/published>/i)?.[1] ??
      block.match(/<updated>([\s\S]*?)<\/updated>/i)?.[1] ?? "";
    const source = cleanText(
      block.match(/<author[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/i)?.[1] ?? ""
    );
    const rawDesc =
      block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1] ??
      block.match(/<content[^>]*>([\s\S]*?)<\/content>/i)?.[1] ?? "";
    const cleaned = cleanText(rawDesc).slice(0, 500);
    const summary = isJustTitle(cleaned, title) ? "" : cleaned;

    const pubDate = new Date(pubDateStr);
    if (!title || !url || isNaN(pubDate.getTime())) continue;
    if (pubDate.toISOString().slice(0, 10) < fromIso) continue;

    const hay = `${title} ${summary} ${source}`.toLowerCase();
    const isNonIndia =
      /\b(china|pakistan|usa|europe|africa|australia|germany|france)\b/.test(hay) &&
      !hay.includes("india") && !hay.includes("indian");
    if (isNonIndia) continue;
    if (!POWER_TERMS.some((t) => hay.includes(t))) continue;

    items.push({ title, url, source, publishedAtISO: pubDate.toISOString(), summary, isPriority });
  }

  return items;
}

/** Deduplicate by title, keep newest first; priority items sort before GN items */
function dedup(items: Item[]): Item[] {
  const seen = new Set<string>();
  return items
    .sort((a, b) => {
      // Priority feeds first, then by date descending
      if (a.isPriority !== b.isPriority) return a.isPriority ? -1 : 1;
      return a.publishedAtISO < b.publishedAtISO ? 1 : -1;
    })
    .filter((item) => {
      const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export default async function handler(): Promise<Response> {
  // Date range: last 10 days
  const fromDate = new Date();
  fromDate.setUTCDate(fromDate.getUTCDate() - 10);
  const fromIso = fromDate.toISOString().slice(0, 10);

  // Fetch all feeds in parallel
  const allFeeds = [
    ...PRIORITY_FEEDS.map((url) => ({ url, isPriority: true })),
    ...GN_FEEDS.map((url) => ({ url, isPriority: false })),
  ];

  const results = await Promise.allSettled(
    allFeeds.map(({ url }) =>
      fetch(url, { headers: FETCH_HEADERS }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
    )
  );

  const allItems: Item[] = [];
  results.forEach((result, idx) => {
    if (result.status === "fulfilled") {
      const isPriority = allFeeds[idx].isPriority;
      allItems.push(...parseItems(result.value, fromIso, isPriority));
    }
  });

  const top5 = dedup(allItems).slice(0, 5);

  return new Response(
    JSON.stringify({
      items: top5.map(({ title, url, source, publishedAtISO, summary }) => ({
        title,
        url,
        source,
        publishedAtISO,
        summary,
      })),
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "s-maxage=1800, stale-while-revalidate=300",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
