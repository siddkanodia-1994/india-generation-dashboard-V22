/**
 * Vercel Edge Function — /api/news
 *
 * Fetches Google News RSS server-side (no CORS proxy needed) and returns
 * the raw XML to the frontend. Edge runtime = no cold starts, global CDN.
 *
 * Vercel caches the response for 30 min at the edge (s-maxage=1800).
 */

export const config = { runtime: "edge" };

const RSS_URL =
  "https://news.google.com/rss/search?q=" +
  encodeURIComponent(
    "India power electricity energy sector coal renewable discom grid demand generation"
  ) +
  "&hl=en-IN&gl=IN&ceid=IN:en";

export default async function handler(): Promise<Response> {
  try {
    const res = await fetch(RSS_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        Accept: "application/rss+xml, application/xml, text/xml, */*",
      },
    });

    if (!res.ok) {
      return new Response("RSS fetch failed", { status: 502 });
    }

    const xml = await res.text();

    return new Response(xml, {
      status: 200,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "s-maxage=1800, stale-while-revalidate=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response("Internal error", { status: 500 });
  }
}
