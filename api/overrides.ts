/**
 * Vercel Edge Function — /api/overrides
 *
 * GET  → returns { commentary: "...", news_section: "..." } from Supabase
 * POST { key, value } → upserts override in Supabase
 *
 * Supabase PostgREST is called directly (no SDK) so the anon key
 * never reaches the browser.
 */

export const config = { runtime: "edge" };

const SB_URL = process.env.SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_ANON_KEY!;

const SB_HEADERS = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ALLOWED_KEYS = new Set(["commentary", "news_section"]);

export default async function handler(req: Request): Promise<Response> {
  // Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // GET → return all overrides
  if (req.method === "GET") {
    const res = await fetch(
      `${SB_URL}/rest/v1/dashboard_overrides?select=key,value`,
      { headers: SB_HEADERS }
    );
    if (!res.ok) {
      return new Response(JSON.stringify({ commentary: "", news_section: "" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }
    const rows: { key: string; value: string }[] = await res.json();
    const out: Record<string, string> = { commentary: "", news_section: "" };
    rows.forEach((r) => (out[r.key] = r.value));
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...CORS,
      },
    });
  }

  // POST → upsert a single key
  if (req.method === "POST") {
    let body: { key?: string; value?: string };
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON", { status: 400, headers: CORS });
    }

    const { key, value } = body;
    if (!key || !ALLOWED_KEYS.has(key) || typeof value !== "string") {
      return new Response("Bad key or value", { status: 400, headers: CORS });
    }

    const res = await fetch(`${SB_URL}/rest/v1/dashboard_overrides`, {
      method: "POST",
      headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
    });

    if (!res.ok) {
      return new Response("Supabase error", { status: 502, headers: CORS });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  return new Response("Method not allowed", { status: 405, headers: CORS });
}
