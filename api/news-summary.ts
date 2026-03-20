/**
 * Vercel Edge Function — /api/news-summary
 *
 * Fetches the same RSS feeds as /api/news, picks the top 5 India power-sector
 * articles, then calls the Claude Haiku API to generate a 2-3 sentence summary
 * for each. Returns JSON: { items: Array<{title,url,source,publishedAtISO,summary}> }
 *
 * Requires ANTHROPIC_API_KEY set in Vercel environment variables.
 * Cached 30 min at the edge (s-maxage=1800).
 */

export const config = { runtime: "edge" };

const GN = (q: string) =>
  "https://news.google.com/rss/search?q=" +
  encodeURIComponent(q) +
  "&hl=en-IN&gl=IN&ceid=IN:en";

const FEEDS = [
  GN("India power electricity sector coal discom grid demand generation"),
  GN("India solar wind renewable energy NTPC IEX RTM DAM tariff capacity"),
  GN("India peak demand power shortage thermal hydro PLF generation"),
  "https://economictimes.indiatimes.com/industry/energy/rss",
  "https://mercomindia.com/feed/",
  "https://www.business-standard.com/rss/power-sector-12.rss",
  "https://powerline.net.in/feed/",
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

type RawItem = {
  title: string;
  url: string;
  source: string;
  publishedAtISO: string;
  feedSnippet: string;
};

/** Strip HTML tags from a string */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Extract structured items from raw RSS/Atom XML using regex (no DOMParser in Edge) */
function parseItems(xml: string, fromIso: string): RawItem[] {
  const items: RawItem[] = [];

  // RSS <item>
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const block = m[0];
    const title = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]?.trim() ?? "";
    const link =
      block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]?.trim() ??
      block.match(/<link[^>]+href="([^"]+)"/i)?.[1] ?? "";
    const pubDateStr = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() ?? "";
    const source = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i)?.[1]?.trim() ?? "";
    const rawDesc = block.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)?.[1] ?? "";
    const feedSnippet = stripTags(rawDesc).slice(0, 300);

    const pubDate = new Date(pubDateStr);
    if (!title || !link || isNaN(pubDate.getTime())) continue;
    if (pubDate.toISOString().slice(0, 10) < fromIso) continue;

    const hay = `${title} ${feedSnippet} ${source}`.toLowerCase();
    const isNonIndia =
      /\b(china|pakistan|usa|europe|africa|australia|germany|france)\b/.test(hay) &&
      !hay.includes("india") && !hay.includes("indian");
    if (isNonIndia) continue;
    if (!POWER_TERMS.some((t) => hay.includes(t))) continue;

    items.push({ title, url: link, source, publishedAtISO: pubDate.toISOString(), feedSnippet });
  }

  // Atom <entry>
  for (const m of xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)) {
    const block = m[0];
    const title = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
    const link =
      block.match(/<link[^>]+href="([^"]+)"/i)?.[1] ??
      block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]?.trim() ?? "";
    const pubDateStr =
      block.match(/<published>([\s\S]*?)<\/published>/i)?.[1] ??
      block.match(/<updated>([\s\S]*?)<\/updated>/i)?.[1] ?? "";
    const source = block.match(/<author[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/i)?.[1]?.trim() ?? "";
    const rawDesc =
      block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1] ??
      block.match(/<content[^>]*>([\s\S]*?)<\/content>/i)?.[1] ?? "";
    const feedSnippet = stripTags(rawDesc).slice(0, 300);

    const pubDate = new Date(pubDateStr);
    if (!title || !link || isNaN(pubDate.getTime())) continue;
    if (pubDate.toISOString().slice(0, 10) < fromIso) continue;

    const hay = `${title} ${feedSnippet} ${source}`.toLowerCase();
    const isNonIndia =
      /\b(china|pakistan|usa|europe|africa|australia|germany|france)\b/.test(hay) &&
      !hay.includes("india") && !hay.includes("indian");
    if (isNonIndia) continue;
    if (!POWER_TERMS.some((t) => hay.includes(t))) continue;

    items.push({ title, url: link, source, publishedAtISO: pubDate.toISOString(), feedSnippet });
  }

  return items;
}

/** Deduplicate by title similarity, keep newest first */
function dedup(items: RawItem[]): RawItem[] {
  const seen = new Set<string>();
  return items
    .sort((a, b) => (a.publishedAtISO < b.publishedAtISO ? 1 : -1))
    .filter((item) => {
      const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function generateSummary(
  title: string,
  source: string,
  feedSnippet: string,
  apiKey: string
): Promise<string> {
  const prompt = `You are writing a concise brief for an India electricity market dashboard.
Article title: "${title}"
Source: ${source || "news source"}
${feedSnippet && feedSnippet.length > 20 ? `Feed description: ${feedSnippet}\n` : ""}
Write 2-3 sentences explaining what this article covers and its key insight for India's power sector. Be specific and factual. Do not start with "This article".`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 180,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return feedSnippet.slice(0, 300);
    const data = await res.json() as { content?: Array<{ text: string }> };
    return data.content?.[0]?.text?.trim() ?? feedSnippet.slice(0, 300);
  } catch {
    return feedSnippet.slice(0, 300);
  }
}

export default async function handler(req: Request): Promise<Response> {
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not set" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Date range: last 10 days
  const toDate = new Date();
  const fromDate = new Date(toDate);
  fromDate.setUTCDate(fromDate.getUTCDate() - 10);
  const fromIso = fromDate.toISOString().slice(0, 10);

  // Fetch all feeds in parallel
  const results = await Promise.allSettled(
    FEEDS.map((url) =>
      fetch(url, { headers: FETCH_HEADERS }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
    )
  );

  const allXml = results
    .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
    .map((r) => r.value)
    .join("\n");

  const candidates = dedup(parseItems(allXml, fromIso)).slice(0, 5);

  if (candidates.length === 0) {
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "s-maxage=1800, stale-while-revalidate=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // Generate AI summaries in parallel
  const withSummaries = await Promise.all(
    candidates.map(async (item) => ({
      title: item.title,
      url: item.url,
      source: item.source,
      publishedAtISO: item.publishedAtISO,
      summary: await generateSummary(item.title, item.source, item.feedSnippet, apiKey),
    }))
  );

  return new Response(JSON.stringify({ items: withSummaries }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "s-maxage=1800, stale-while-revalidate=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
