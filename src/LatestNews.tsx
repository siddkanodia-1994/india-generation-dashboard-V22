import React, { useEffect, useMemo, useState } from "react";

type NewsItem = {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAtISO: string;
  snippet: string;
};

const CACHE_KEY = "latestNews_cache_v6"; // bumped to clear stale caches
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MIN_DATE = "2015-01-01";

const POWER_TERMS = [
  "power",
  "electricity",
  "grid",
  "demand",
  "supply",
  "peak",
  "renewable",
  "solar",
  "wind",
  "coal",
  "plf",
  "transmission",
  "discom",
  "tariff",
  "energy",
  "rtm",
  "dam",
  "iex",
  "thermal",
  "hydro",
  "capacity",
  "generation",
  "shortage",
  "ntpc",
  "nhpc",
  "genco",
  "ppa",
  "mw",
  "gw",
];

// Server-side proxy via Vercel Edge Function (no CORS issues)
const NEWS_API = "/api/news";

function isoDate(d: Date) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

function todayISODate() {
  return isoDate(new Date());
}

function daysBeforeISO(endISO: string, days: number) {
  const d = new Date(endISO + "T00:00:00");
  d.setDate(d.getDate() - days);
  return isoDate(d);
}

function formatDDMMYYYY(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getDate()).padStart(2, "0")}/${String(
    d.getMonth() + 1
  ).padStart(2, "0")}/${d.getFullYear()}`;
}

function clamp(text = "", n = 180) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
}

function isRelevant(item: NewsItem) {
  const hay = `${item.title} ${item.snippet} ${item.source}`.toLowerCase();
  // India check skipped — all our RSS sources are India-targeted
  // (India-specific publications don't always say "india" in their own articles)
  const mentionsPower = POWER_TERMS.some((t) => hay.includes(t));
  // Reject clearly non-India content
  const isNonIndia = /\b(china|pakistan|usa|europe|africa|australia|uk |united kingdom|germany|france)\b/.test(hay) &&
    !hay.includes("india") && !hay.includes("indian");
  return mentionsPower && !isNonIndia;
}

function loadCache(): NewsItem[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj.ts !== "number" || !Array.isArray(obj.items)) return null;
    if (Date.now() - obj.ts > CACHE_TTL_MS) return null;
    if (obj.items.length === 0) return null; // don't use cached empty results
    return obj.items as NewsItem[];
  } catch {
    return null;
  }
}

function saveCache(items: NewsItem[]) {
  if (items.length === 0) return; // never cache empty results
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), items }));
  } catch {
    // ignore
  }
}

async function fetchGoogleNewsRSS(forceFresh: boolean): Promise<NewsItem[]> {
  const url = forceFresh ? `${NEWS_API}?cb=${Date.now()}` : NEWS_API;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error("News API failed");

  const xmlText = await res.text();
  if (!xmlText.includes("<item>")) throw new Error("No items in RSS response");

  const xml = new DOMParser().parseFromString(xmlText, "text/xml");
  const items = Array.from(xml.querySelectorAll("item"));

  return items
    .map((item, i) => {
      const title = item.querySelector("title")?.textContent?.trim() || "";
      const link = item.querySelector("link")?.textContent?.trim() || "";
      const pubDate = item.querySelector("pubDate")?.textContent?.trim() || "";
      const source = item.querySelector("source")?.textContent?.trim() || "Google News";

      const desc = (item.querySelector("description")?.textContent || "").replace(
        /<[^>]+>/g,
        ""
      );

      const publishedAtISO = pubDate ? new Date(pubDate).toISOString() : "";
      if (!title || !link || !publishedAtISO) return null;

      return {
        id: `${publishedAtISO}_${i}`,
        title,
        url: link,
        source,
        publishedAtISO,
        snippet: clamp(desc, 200),
      } as NewsItem;
    })
    .filter(Boolean) as NewsItem[];
}

function Card({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 p-4">
        <div className="text-sm font-semibold text-slate-800">{title}</div>
        {right ? <div className="text-sm text-slate-600">{right}</div> : null}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function ExternalIcon() {
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-slate-100 text-slate-600">
      ↗
    </span>
  );
}

export default function LatestNews() {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Defaults: End=today, Start=today-14 (widened from 7)
  const [endDate, setEndDate] = useState<string>(() => todayISODate());
  const [startDate, setStartDate] = useState<string>(() => daysBeforeISO(todayISODate(), 14));

  const todayMax = todayISODate();

  useEffect(() => {
    // Clamp to valid ranges
    if (endDate > todayMax) setEndDate(todayMax);
    if (startDate > endDate) setStartDate(endDate);
    if (startDate < MIN_DATE) setStartDate(MIN_DATE);
    if (endDate < MIN_DATE) setEndDate(MIN_DATE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endDate]);

  const filtered = useMemo(() => {
    const fromT = new Date(startDate + "T00:00:00").getTime();
    const toT = new Date(endDate + "T23:59:59").getTime();

    return items
      .filter((n) => {
        const t = new Date(n.publishedAtISO).getTime();
        return Number.isFinite(t) && t >= fromT && t <= toT;
      })
      .sort((a, b) => (a.publishedAtISO < b.publishedAtISO ? 1 : -1));
  }, [items, startDate, endDate]);

  async function load(force = false) {
    setLoading(true);
    setError(null);

    try {
      if (!force) {
        const cached = loadCache();
        if (cached) {
          setItems(cached);
          setLoading(false);
          return;
        }
      }

      const raw = await fetchGoogleNewsRSS(force);
      const relevant = raw.filter(isRelevant).slice(0, 100);

      setItems(relevant);
      saveCache(relevant); // only saves if relevant.length > 0
    } catch {
      setError("Unable to load news – please try again later");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(false);
  }, []);

  function setLast14DaysPreset() {
    const end = todayISODate();
    const start = daysBeforeISO(end, 14);
    setEndDate(end);
    setStartDate(start);
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-8">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-2xl font-semibold text-slate-900">Latest News</div>
            <div className="mt-1 text-sm text-slate-600">
              Real-time news and reports focused on the Indian power sector.
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => load(true)}
              className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
              disabled={loading}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        <div className="mt-6">
          <Card
            title="Filter"
            right={
              <div className="flex items-center gap-2">
                <button
                  onClick={setLast14DaysPreset}
                  className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
                >
                  Last 14 Days
                </button>
                <button
                  onClick={setLast14DaysPreset}
                  className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
                >
                  Reset
                </button>
              </div>
            }
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end">
              <div>
                <div className="text-xs font-medium text-slate-600">Start date</div>
                <input
                  type="date"
                  value={startDate}
                  min={MIN_DATE}
                  max={endDate}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (!v) return;
                    setStartDate(v < MIN_DATE ? MIN_DATE : v > endDate ? endDate : v);
                  }}
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-slate-300"
                />
              </div>

              <div>
                <div className="text-xs font-medium text-slate-600">End date</div>
                <input
                  type="date"
                  value={endDate}
                  min={MIN_DATE}
                  max={todayMax}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (!v) return;
                    const clamped = v > todayMax ? todayMax : v < MIN_DATE ? MIN_DATE : v;
                    setEndDate(clamped);
                  }}
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-slate-300"
                />
              </div>

              <div className="text-sm text-slate-600">
                Showing{" "}
                <span className="font-semibold text-slate-900">{filtered.length}</span>{" "}
                articles
              </div>
            </div>
          </Card>
        </div>

        {/* show error only if we have nothing to display */}
        {error && filtered.length === 0 ? (
          <div className="mt-6 rounded-2xl bg-rose-50 p-4 text-rose-800 ring-1 ring-rose-200">
            <div className="font-semibold">{error}</div>
            <button
              onClick={() => load(true)}
              className="mt-3 rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Retry
            </button>
          </div>
        ) : null}

        <div className="mt-6">
          {loading && !items.length ? (
            <div className="text-sm text-slate-600">Loading news…</div>
          ) : null}

          {!loading && !error && filtered.length === 0 ? (
            <div className="text-sm text-slate-600">No articles found for this range.</div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {filtered.map((a) => (
              <div
                key={a.id}
                className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
              >
                <div className="flex items-start justify-between gap-3">
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-base font-semibold text-slate-900 hover:underline"
                  >
                    {a.title}
                  </a>
                  <a href={a.url} target="_blank" rel="noreferrer" title="Open">
                    <ExternalIcon />
                  </a>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
                  <span className="font-medium">{a.source}</span>
                  <span>•</span>
                  <span>{formatDDMMYYYY(a.publishedAtISO)}</span>
                </div>

                <div className="mt-3 text-sm text-slate-700">{a.snippet}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-6 text-xs text-slate-500">
          Cached for up to 1 hour. Refresh to fetch latest.
        </div>
      </div>
    </div>
  );
}
