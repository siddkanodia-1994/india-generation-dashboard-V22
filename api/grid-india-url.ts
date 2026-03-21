/**
 * Vercel Edge Function — /api/grid-india-url
 *
 * Proxy for the Grid India REST API. GitHub Actions runner IPs (AWS us-east-1)
 * are blocked by webapi.grid-india.in at the TLS level. This endpoint runs on
 * Vercel's edge network (unblocked) and forwards the file-listing request.
 *
 * GET ?fy=2025-26&month=03&date=20.03.26
 * Returns: { url: "https://webcdn.grid-india.in/..." } or { url: null }
 */

export const config = { runtime: "edge" };

const GRID_API_URL  = "https://webapi.grid-india.in/api/v1/file";
const GRID_CDN_BASE = "https://webcdn.grid-india.in";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const GRID_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-IN,en;q=0.9",
  "Content-Type": "application/json",
  Origin: "https://grid-india.in",
  Referer: "https://grid-india.in/en/reports/daily-psp-report",
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const { searchParams } = new URL(req.url);
  const fy    = searchParams.get("fy");
  const month = searchParams.get("month");
  const date  = searchParams.get("date");

  if (!fy || !month || !date) {
    return new Response(
      JSON.stringify({ error: "Missing required params: fy, month, date" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS } }
    );
  }

  try {
    const res = await fetch(GRID_API_URL, {
      method: "POST",
      headers: GRID_HEADERS,
      body: JSON.stringify({
        _source: "GRDW",
        _type: "DAILY_PSP_REPORT",
        _fileDate: fy,
        _month: month,
      }),
    });

    if (!res.ok) {
      return new Response(
        JSON.stringify({ url: null, error: `Grid India API returned ${res.status}` }),
        { status: 200, headers: { "Content-Type": "application/json", ...CORS } }
      );
    }

    const data = await res.json();
    const items: { FilePath?: string }[] = data?.retData ?? [];

    let xlsUrl: string | null = null;
    for (const item of items) {
      const fp = item.FilePath ?? "";
      if (fp.includes(date) && fp.endsWith(".xls")) {
        xlsUrl = `${GRID_CDN_BASE}/${fp}`;
        break;
      }
    }

    return new Response(JSON.stringify({ url: xlsUrl }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...CORS,
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ url: null, error: String(err) }),
      { status: 200, headers: { "Content-Type": "application/json", ...CORS } }
    );
  }
}
