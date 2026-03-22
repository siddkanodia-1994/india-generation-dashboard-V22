import React, { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ReferenceLine,
  ScatterChart,
  Scatter
} from "recharts";

type Mode = "price" | "ptb";
type WindowDays = 1 | 7 | 14 | 30 | 45;
type RangePreset = "1m" | "3m" | "6m" | "12m" | "24m" | "36m" | "ytd" | "all";

/* -----------------------------
   Date + parsing helpers
----------------------------- */

function parseISOKey(s: string) {
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!ok) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : s;
}

function excelSerialToISO(n: number) {
  if (!Number.isFinite(n)) return null;
  // Excel serial -> UTC date (Excel epoch 1899-12-30)
  const ms = Math.round(n * 86400000);
  const base = Date.UTC(1899, 11, 30);
  const d = new Date(base + ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// ✅ FIXED (timezone-proof): Excel Date object -> ISO
// Strategy: shift by +12h then take UTC date parts (prevents T-1 in any timezone)
function dateObjToLocalISO(d: Date) {
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;

  const d2 = new Date(ms + 12 * 60 * 60 * 1000); // +12h
  const yyyy = d2.getUTCFullYear();
  const mm = d2.getUTCMonth() + 1;
  const dd = d2.getUTCDate();
  return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

// Accepts:
// - Date objects (from XLSX cellDates:true) ✅
// - Excel serial numbers ✅
// - DD/MM/YYYY, DD/MM/YY, DD-MM-YYYY, DD-MM-YY ✅
// - ISO YYYY-MM-DD ✅
function parseInputDate(s: unknown) {
  if (s instanceof Date && !Number.isNaN(s.getTime())) return dateObjToLocalISO(s);

  if (typeof s === "number" && Number.isFinite(s)) {
    if (s > 20000 && s < 80000) return excelSerialToISO(s);
  }

  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t) return null;

  let m: RegExpMatchArray | null;

  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = Number(m[3]);
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (!Number.isNaN(d.getTime()))
      return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    return null;
  }

  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = 2000 + Number(m[3]);
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (!Number.isNaN(d.getTime()))
      return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    return null;
  }

  m = t.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = Number(m[3]);
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (!Number.isNaN(d.getTime()))
      return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    return null;
  }

  m = t.match(/^(\d{1,2})-(\d{1,2})-(\d{2})$/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = 2000 + Number(m[3]);
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (!Number.isNaN(d.getTime()))
      return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return parseISOKey(t);
  return null;
}

function isoMinusDays(iso: string, days: number) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function isoPlusDays(iso: string, days: number) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isoMinusMonths(anchorIso: string, months: number) {
  const d = new Date(anchorIso + "T00:00:00Z");
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();

  const targetMonthIndex = m - months;
  const targetDate = new Date(Date.UTC(y, targetMonthIndex, 1));
  const lastDay = new Date(
    Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth() + 1, 0)
  ).getUTCDate();
  const clampedDay = Math.min(day, lastDay);

  const out = new Date(
    Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), clampedDay)
  );
  return out.toISOString().slice(0, 10);
}

function isoStartOfYear(iso: string) {
  const d = new Date(iso + "T00:00:00Z");
  const y = d.getUTCFullYear();
  return new Date(Date.UTC(y, 0, 1)).toISOString().slice(0, 10);
}

function formatDDMMYYYY(iso: string) {
  if (!iso || typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

function formatDDMMYY(iso: string) {
  if (!iso || typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y.slice(2)}`;
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function growthPct(curr: number, prev: number) {
  if (!Number.isFinite(curr) || !Number.isFinite(prev) || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

function normalizeKey(s: string) {
  return (s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/–/g, "-")
    .replace(/—/g, "-");
}

function parseRtmCsv(text: string, valueColumnKey: string) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return new Map<string, number>();

  const header = lines[0].split(",").map((h) => normalizeKey(h));
  const want = normalizeKey(valueColumnKey);
  const valueIdx = header.indexOf(want) >= 0 ? header.indexOf(want) : 1;

  const m = new Map<string, number>();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    if (cols.length < 2) continue;

    const d = parseInputDate(cols[0]);
    const v = asFiniteNumber(String(cols[valueIdx] ?? cols[1] ?? "").replace(/,/g, ""));
    if (!d || v == null) continue;
    m.set(d, v);
  }
  return m;
}

/* -----------------------------
   ✅ ADD: Log helpers (safe)
----------------------------- */

function log10Safe(v: number | null) {
  if (v == null) return null;
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.log10(v);
}

// ✅ Color for correlation display
function corrColorClass(r: number | null) {
  if (r == null || !Number.isFinite(r)) return "text-slate-600";
  if (Math.abs(r) < 0.1) return "text-slate-600";
  return r > 0 ? "text-emerald-700" : "text-rose-700";
}

// ✅ formatter: linear shows % like before, log shows raw r (0.68)
function fmtCorrDisplay(r: number | null) {
  if (r == null || Number.isNaN(r)) return "—";
  return `${(r * 100).toFixed(2)}%`;
}

/* -----------------------------
   ✅ ADD: Pearson correlation helper (Excel CORREL)
----------------------------- */

function pearsonCorrPairs(pairs: Array<[number, number]>) {
  const n = pairs.length;
  if (n < 2) return null;

  let sumX = 0,
    sumY = 0,
    sumXX = 0,
    sumYY = 0,
    sumXY = 0;

  for (const [x, y] of pairs) {
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumYY += y * y;
    sumXY += x * y;
  }

  const num = n * sumXY - sumX * sumY;
  const denX = n * sumXX - sumX * sumX;
  const denY = n * sumYY - sumY * sumY;
  const den = Math.sqrt(Math.max(0, denX) * Math.max(0, denY));

  if (!Number.isFinite(den) || den === 0) return null;

  const r = num / den;
  return Number.isFinite(r) ? Math.max(-1, Math.min(1, r)) : null;
}

/* -----------------------------
   ✅ ADD: Linear regression + R² (for scatter)
----------------------------- */

function linearRegressionPairs(pairs: Array<[number, number]>) {
  const n = pairs.length;
  if (n < 2) return null;

  let sumX = 0,
    sumY = 0,
    sumXX = 0,
    sumXY = 0;

  for (const [x, y] of pairs) {
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
  }

  const den = n * sumXX - sumX * sumX;
  if (!Number.isFinite(den) || den === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / den;
  const intercept = (sumY - slope * sumX) / n;

  // R²
  const meanY = sumY / n;
  let sse = 0;
  let sst = 0;
  for (const [x, y] of pairs) {
    const yHat = slope * x + intercept;
    sse += (y - yHat) ** 2;
    sst += (y - meanY) ** 2;
  }
  const r2 =
    sst === 0
      ? sse === 0
        ? 1
        : 0
      : 1 - sse / sst;

  return {
    slope,
    intercept,
    r2: Number.isFinite(r2) ? Math.max(0, Math.min(1, r2)) : null
  };
}

/* -----------------------------
   XLSX load
----------------------------- */

type StockSheets = {
  prices: {
    dates: string[];
    cols: string[];
    values: Map<string, Map<string, number>>;
    latestDate: string | null;
  };
  ptb: {
    dates: string[];
    cols: string[];
    values: Map<string, Map<string, number>>;
    latestDate: string | null;
  };
};

function buildEmptySheets(): StockSheets {
  return {
    prices: { dates: [], cols: [], values: new Map(), latestDate: null },
    ptb: { dates: [], cols: [], values: new Map(), latestDate: null }
  };
}

async function loadStockXlsx(url: string): Promise<StockSheets> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Stock file HTTP ${res.status}`);

  const buf = await res.arrayBuffer();
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buf, { type: "array", cellDates: true });

  const sheetNames = wb.SheetNames || [];
  const s1 = sheetNames[0];
  const s2 = sheetNames[1];

  const out = buildEmptySheets();

  function parseSheet(sheetName: string | undefined) {
    if (!sheetName) {
      return {
        dates: [] as string[],
        cols: [] as string[],
        values: new Map(),
        latestDate: null as string | null
      };
    }

    const ws = wb.Sheets[sheetName];
    // raw:true ensures Date objects remain Date if cellDates:true
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true }) as any[][];
    if (!aoa || aoa.length < 2) return { dates: [], cols: [], values: new Map(), latestDate: null };

    const header = (aoa[0] || []).map((x) => String(x ?? "").trim());
    const cols = header.slice(1).filter(Boolean);

    const values = new Map<string, Map<string, number>>();
    for (const c of cols) values.set(c, new Map());

    const dates: string[] = [];

    for (let r = 1; r < aoa.length; r++) {
      const row = aoa[r] || [];
      const d = parseInputDate(row[0]); // ✅ FIXED date parsing
      if (!d) continue;

      let any = false;
      for (let ci = 0; ci < cols.length; ci++) {
        const colName = cols[ci];
        const v = asFiniteNumber(row[ci + 1]);
        if (v == null) continue;
        values.get(colName)!.set(d, v);
        any = true;
      }
      if (any) dates.push(d);
    }

    dates.sort();
    const latestDate = dates.length ? dates[dates.length - 1] : null;
    return { dates, cols, values, latestDate };
  }

  out.prices = parseSheet(s1);
  out.ptb = parseSheet(s2);
  return out;
}

/* -----------------------------
   Rolling
----------------------------- */

// STOCK rolling: last N available trading days <= anchor (skips missing dates)
function rollingAvgStocks(series: Map<string, number>, anchor: string, n: number) {
  const dates = Array.from(series.keys()).filter((d) => d <= anchor).sort();
  if (!dates.length) return null;

  const last = dates.slice(Math.max(0, dates.length - n));
  if (!last.length) return null;

  const vals = last.map((d) => series.get(d)!).filter((v) => Number.isFinite(v));
  if (!vals.length) return null;

  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// RTM rolling: calendar days window ending at anchor (skips missing values)
function rollingAvgRtm(series: Map<string, number>, anchor: string, n: number) {
  const start = isoMinusDays(anchor, n - 1);
  let cur = start;
  let sum = 0;
  let count = 0;

  while (cur <= anchor) {
    const v = series.get(cur);
    if (v != null) {
      sum += v;
      count += 1;
    }
    cur = isoPlusDays(cur, 1);
  }

  if (!count) return null;
  return sum / count;
}

/* -----------------------------
   UI helpers
----------------------------- */

function Card({
  title,
  right,
  children
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

// Different colors for multiple stocks
const STOCK_COLORS = ["#2563eb", "#9333ea", "#0f766e", "#f59e0b", "#ef4444", "#16a34a", "#db2777", "#475569"];
function getStockColor(i: number) {
  return STOCK_COLORS[i % STOCK_COLORS.length];
}

/* -----------------------------
   Component
----------------------------- */

export default function RTMVsStocksDailyCard(props: {
  rtmCsvUrl: string;
  stockFileUrl: string;
  rtmValueColumnKey: string;
}) {
  const { rtmCsvUrl, stockFileUrl, rtmValueColumnKey } = props;

  const [rtmMap, setRtmMap] = useState<Map<string, number>>(new Map());
  const [stockSheets, setStockSheets] = useState<StockSheets>(buildEmptySheets());

  const [mode, setMode] = useState<Mode>("price");
  const [windowDays, setWindowDays] = useState<WindowDays>(45);
  const periodLabel = windowDays === 1 ? "daily" : `${windowDays}d rolling`;
  const [showYoY, setShowYoY] = useState(false);
  const [showRtmControlLines, setShowRtmControlLines] = useState(false);

  // ✅ NEW: One toggle for log-log view + correlation
  const [useLogScale, setUseLogScale] = useState<boolean>(false);

  // Lag control (days) – RTM only
  const [lagDays, setLagDays] = useState<number>(0);

  const [selectedStocks, setSelectedStocks] = useState<string[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Presets + manual range (✅ now stored as ISO for native date picker)
  const [preset, setPreset] = useState<RangePreset>("24m");
  const [fromIso, setFromIso] = useState<string>(""); // YYYY-MM-DD
  const [toIso, setToIso] = useState<string>(""); // YYYY-MM-DD

  // ✅ Scatter options (shared state for the new card)
  const [showScatterEqn, setShowScatterEqn] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        setLoading("Loading RTM + Stocks...");
        setErr(null);

        const rtmRes = await fetch(`${encodeURI(rtmCsvUrl)}?v=${Date.now()}`);
        if (!rtmRes.ok) throw new Error(`RTM HTTP ${rtmRes.status}`);
        const rtmText = await rtmRes.text();
        const rtm = parseRtmCsv(rtmText, rtmValueColumnKey);

        const stocks = await loadStockXlsx(`${encodeURI(stockFileUrl)}?v=${Date.now()}`);

        if (cancelled) return;

        setRtmMap(rtm);
        setStockSheets(stocks);

        const cols = stocks.prices.cols.length ? stocks.prices.cols : stocks.ptb.cols;
        setSelectedStocks(cols.slice(0, Math.min(1, cols.length)));

        setLoading(null);
      } catch (e: any) {
        if (!cancelled) {
          setErr(e?.message || "Failed to load RTM/Stock data.");
          setLoading(null);
        }
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [rtmCsvUrl, stockFileUrl, rtmValueColumnKey]);

  const activeSheet = mode === "price" ? stockSheets.prices : stockSheets.ptb;
  const stockUniverse = activeSheet.cols;

  // Stock anchor = latest stock date in active sheet
  const anchorDate = activeSheet.latestDate;

  // Apply preset -> fill ISO inputs (✅ works with native date picker)
  useEffect(() => {
    if (!anchorDate) return;

    const to = anchorDate;

    let from = isoMinusMonths(anchorDate, 24);
    if (preset === "1m") from = isoMinusMonths(anchorDate, 1);
    if (preset === "3m") from = isoMinusMonths(anchorDate, 3);
    if (preset === "6m") from = isoMinusMonths(anchorDate, 6);
    if (preset === "12m") from = isoMinusMonths(anchorDate, 12);
    if (preset === "24m") from = isoMinusMonths(anchorDate, 24);
    if (preset === "36m") from = isoMinusMonths(anchorDate, 36);
    if (preset === "ytd") from = isoStartOfYear(anchorDate);

    if (preset === "all") {
      const earliest = activeSheet.dates.length ? activeSheet.dates[0] : isoMinusMonths(anchorDate, 36);
      from = earliest;
    }

    setToIso(to);
    setFromIso(from);
  }, [anchorDate, preset, activeSheet.dates]);

  const range = useMemo(() => {
    if (!anchorDate) return { fromIso: null as string | null, toIso: null as string | null };

    const safeTo = toIso && /^\d{4}-\d{2}-\d{2}$/.test(toIso) && toIso <= anchorDate ? toIso : anchorDate;

    // from must be <= to
    const safeFrom =
      fromIso && /^\d{4}-\d{2}-\d{2}$/.test(fromIso) && fromIso <= safeTo ? fromIso : isoMinusMonths(anchorDate, 24);

    return { fromIso: safeFrom, toIso: safeTo };
  }, [anchorDate, fromIso, toIso]);

  // RTM anchor is shifted back by lagDays (clamped)
  const rtmAnchor = useMemo(() => {
    if (!range.toIso) return null;
    const lag = Math.max(0, Math.min(365, Math.floor(Number(lagDays) || 0)));
    return isoMinusDays(range.toIso, lag);
  }, [range.toIso, lagDays]);

  // Chart series
  const chartData = useMemo(() => {
    if (!range.fromIso || !range.toIso) return [];
    if (!rtmMap.size) return [];

    const lag = Math.max(0, Math.min(365, Math.floor(Number(lagDays) || 0)));

    const points: any[] = [];
    let cur = range.fromIso;

    while (cur <= range.toIso) {
      const rtmDate = lag ? isoMinusDays(cur, lag) : cur;

      const rtmLinear = rollingAvgRtm(rtmMap, rtmDate, windowDays);
      const rtm = useLogScale ? log10Safe(rtmLinear) : rtmLinear;

      const row: any = {
        label: formatDDMMYYYY(cur),
        __iso: cur,
        rtm,
        __rtmIso: rtmDate,
        __rtmLinear: rtmLinear
      };

      for (const s of selectedStocks) {
        const series = activeSheet.values.get(s);
        if (!series) continue;

        const vLinear = rollingAvgStocks(series, cur, windowDays);
        row[s] = useLogScale ? log10Safe(vLinear) : vLinear;

        row[`__${s}_linear`] = vLinear;
      }

      if (showYoY) {
        const py = isoMinusDays(cur, 365);
        const rtmPYDate = lag ? isoMinusDays(py, lag) : py;

        const rtmPY = rollingAvgRtm(rtmMap, rtmPYDate, windowDays);
        row.rtm_yoy = rtmLinear != null && rtmPY != null ? growthPct(rtmLinear, rtmPY) : null;

        for (const s of selectedStocks) {
          const series = activeSheet.values.get(s);
          if (!series) continue;
          const v = row[`__${s}_linear`] as number | null;
          const vPY = rollingAvgStocks(series, py, windowDays);
          row[`${s}_yoy`] = v != null && vPY != null ? growthPct(v, vPY) : null;
        }
      }

      points.push(row);
      cur = isoPlusDays(cur, 1);
    }

    return points;
  }, [range, rtmMap, activeSheet, selectedStocks, windowDays, showYoY, lagDays, useLogScale]);

  // RTM control lines computed on visible RTM series (already lagged)
  const rtmControl = useMemo(() => {
    const vals = chartData
      .map((r) => asFiniteNumber(r?.rtm))
      .filter((x): x is number => x != null && Number.isFinite(x));
    if (!vals.length) return null;

    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance =
      vals.length > 1 ? vals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (vals.length - 1) : 0;
    const sd = Math.sqrt(Math.max(0, variance));

    return { mean, sd, p1: mean + sd, p2: mean + 2 * sd, m1: mean - sd, m2: mean - 2 * sd };
  }, [chartData]);

  // Quick stats (+ ✅ correlation over visible chartData window)
  const quickStats = useMemo(() => {
    if (!chartData.length) return null;
    const last = chartData[chartData.length - 1];

    const rtm = asFiniteNumber(last?.rtm);
    const stocks: Record<string, number | null> = {};
    for (const s of selectedStocks) stocks[s] = asFiniteNumber(last?.[s]);

    // ✅ CORREL(RTM rolling, Stock rolling) over currently visible chartData range
    const corr: Record<string, number | null> = {};
    for (const s of selectedStocks) {
      const pairs: Array<[number, number]> = [];
      for (const row of chartData) {
        const x = asFiniteNumber(row?.rtm);
        const y = asFiniteNumber(row?.[s]);
        if (x == null || y == null) continue;
        pairs.push([x, y]);
      }
      corr[s] = pearsonCorrPairs(pairs);
    }

    const rtmYoY = asFiniteNumber(last?.rtm_yoy);
    const stocksYoY: Record<string, number | null> = {};
    for (const s of selectedStocks) stocksYoY[s] = asFiniteNumber(last?.[`${s}_yoy`]);

    return {
      displayDate: last?.label ?? "—",
      rtmDate: last?.__rtmIso ? formatDDMMYYYY(last.__rtmIso) : "—",
      rtm,
      stocks,
      corr,
      rtmYoY,
      stocksYoY
    };
  }, [chartData, selectedStocks]);

  const fmtRtm = (x: number | null | undefined) => {
    if (x == null || Number.isNaN(x)) return "—";
    return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(x);
  };

  const fmtNum = (x: number | null | undefined) => {
    if (x == null || Number.isNaN(x)) return "—";
    return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(x);
  };

  const fmtPct = (x: number | null | undefined) => {
    if (x == null || Number.isNaN(x)) return "—";
    const sign = x > 0 ? "+" : "";
    return `${sign}${x.toFixed(2)}%`;
  };

  // ✅ R² formatter
  const fmtR2 = (x: number | null | undefined) => {
    if (x == null || Number.isNaN(x)) return "—";
    return x.toFixed(2);
  };

  // ✅ Equation formatter
  const fmtEqn = (slope: number, intercept: number) => {
    const a = slope;
    const b = intercept;
    const sign = b >= 0 ? "+" : "-";
    return `y = ${a.toFixed(4)}x ${sign} ${Math.abs(b).toFixed(4)}`;
  };

  const titleRight = anchorDate ? (
    <div className="flex items-center gap-2 text-xs text-slate-600">
      <span className="text-slate-500">Anchor</span>
      <span className="font-semibold tabular-nums">{formatDDMMYYYY(anchorDate)}</span>
    </div>
  ) : null;

  // ✅ dotted control lines (as requested)
  const CONTROL_STROKE_WIDTH = 2.8;
  const CONTROL_DASH = "3 4"; // dotted-ish
  const lagClamped = Math.max(0, Math.min(365, Math.floor(Number(lagDays) || 0)));

  /* -----------------------------
     ✅ Scatter data + regression
  ----------------------------- */

  type ScatterPoint = {
    x: number;
    y: number;
    dateLabel: string;
    __iso: string;
    stock: string;
  };

  const scatterByStock = useMemo(() => {
    const out: Record<string, ScatterPoint[]> = {};
    for (const s of selectedStocks) out[s] = [];

    for (const row of chartData) {
      const x = asFiniteNumber(row?.rtm);
      if (x == null) continue;

      for (const s of selectedStocks) {
        const y = asFiniteNumber(row?.[s]);
        if (y == null) continue;

        out[s].push({
          x,
          y,
          dateLabel: row?.label ?? "—",
          __iso: row?.__iso ?? "",
          stock: s
        });
      }
    }

    return out;
  }, [chartData, selectedStocks]);

  const regressionByStock = useMemo(() => {
    const out: Record<
      string,
      | {
          slope: number;
          intercept: number;
          r2: number | null;
          line: Array<{ x: number; y: number }>;
        }
      | null
    > = {};

    for (const s of selectedStocks) {
      const pts = scatterByStock[s] || [];
      const pairs: Array<[number, number]> = pts.map((p) => [p.x, p.y]);
      const reg = linearRegressionPairs(pairs);
      if (!reg) {
        out[s] = null;
        continue;
      }

      const xs = pts.map((p) => p.x);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);

      // Handle degenerate
      const a = reg.slope;
      const b = reg.intercept;

      const x1 = Number.isFinite(minX) ? minX : 0;
      const x2 = Number.isFinite(maxX) ? maxX : x1 + 1;

      out[s] = {
        slope: a,
        intercept: b,
        r2: reg.r2,
        line: [
          { x: x1, y: a * x1 + b },
          { x: x2, y: a * x2 + b }
        ]
      };
    }

    return out;
  }, [selectedStocks, scatterByStock]);

  const scatterDomains = useMemo(() => {
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;

    for (const s of selectedStocks) {
      for (const p of scatterByStock[s] || []) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }

    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
      return {
        x: [0, 1] as [number, number],
        y: [0, 1] as [number, number]
      };
    }

    const padX = maxX === minX ? 1 : Math.abs(maxX - minX) * 0.05;
    const padY = maxY === minY ? 1 : Math.abs(maxY - minY) * 0.05;

    return {
      x: [minX - padX, maxX + padX] as [number, number],
      y: [minY - padY, maxY + padY] as [number, number]
    };
  }, [selectedStocks, scatterByStock]);

  /* -----------------------------
     Controls + Quick Stats block (reused in both cards)
     (Same state shared; UI duplicated intentionally as requested)
  ----------------------------- */

  const ControlsAndStats = (
    <>
      {/* Controls */}
      <div className="mb-3 rounded-2xl bg-slate-50 p-2 ring-1 ring-slate-200">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
          <div className="flex-1">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <div className="text-xs font-medium text-slate-600">Metric</div>
                <select
                  value={windowDays}
                  onChange={(e) => setWindowDays(Number(e.target.value) as WindowDays)}
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                >
                  <option value={1}>Daily (No Averaging)</option>
                  <option value={7}>Last 7 Days Rolling (AVG)</option>
                  <option value={14}>Last 14 Days Rolling (AVG)</option>
                  <option value={30}>Last 30 Days Rolling (AVG)</option>
                  <option value={45}>Last 45 Days Rolling (AVG)</option>
                </select>
              </div>

              <div>
                <div className="text-xs font-medium text-slate-600">Compare on</div>
                <div className="mt-1 flex overflow-hidden rounded-xl ring-1 ring-slate-200">
                  <button
                    type="button"
                    onClick={() => setMode("price")}
                    className={`flex-1 px-3 py-2 text-sm font-semibold ${
                      mode === "price" ? "bg-slate-900 text-white" : "bg-white text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    Stock Price
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode("ptb")}
                    className={`flex-1 px-3 py-2 text-sm font-semibold ${
                      mode === "ptb" ? "bg-slate-900 text-white" : "bg-white text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    Price-to-Book
                  </button>
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-slate-600">Lag (days)</div>
                <input
                  type="number"
                  min={0}
                  max={365}
                  step={1}
                  value={lagClamped}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const n = Math.floor(Number(raw));
                    if (!Number.isFinite(n)) {
                      setLagDays(0);
                      return;
                    }
                    setLagDays(Math.max(0, Math.min(365, n)));
                  }}
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                />
                <div className="mt-1 text-[11px] text-slate-500">
                  RTM anchors to{" "}
                  <span className="font-semibold">{range.toIso ? formatDDMMYYYY(rtmAnchor || range.toIso) : "—"}</span>{" "}
                  (To − {lagClamped}d). Stocks anchor to To date.
                </div>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="sm:col-span-1">
                <div className="text-xs font-medium text-slate-600">Preset range</div>
                <select
                  value={preset}
                  onChange={(e) => setPreset(e.target.value as RangePreset)}
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                >
                  <option value="1m">1 month</option>
                  <option value="3m">3 months</option>
                  <option value="6m">6 months</option>
                  <option value="12m">12 months</option>
                  <option value="24m">24 months</option>
                  <option value="36m">36 months</option>
                  <option value="ytd">YTD</option>
                  <option value="all">All time</option>
                </select>
              </div>

              <div>
                <div className="text-xs font-medium text-slate-600">From</div>
                <input
                  type="date"
                  value={fromIso}
                  onChange={(e) => setFromIso(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                />
                <div className="mt-1 text-[11px] text-slate-500">
                  {fromIso ? <span className="font-semibold">{formatDDMMYY(fromIso)}</span> : null}
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-slate-600">To</div>
                <input
                  type="date"
                  value={toIso}
                  onChange={(e) => setToIso(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                />
                <div className="mt-1 text-[11px] text-slate-500">
                  {toIso ? <span className="font-semibold">{formatDDMMYY(toIso)}</span> : null}
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-4">
              {/* ✅ NEW: Log scale toggle (ONLY ONE toggle added) */}
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={useLogScale}
                  onChange={(e) => setUseLogScale(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                <span className="font-medium">Use Log Scale (both axes) + Recalculate Correlation</span>
              </label>

              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={showYoY}
                  onChange={(e) => setShowYoY(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                <span className="font-medium">Show YoY %</span>
              </label>

              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={showRtmControlLines}
                  onChange={(e) => setShowRtmControlLines(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                <span className="font-medium">Show RTM control lines (Mean, ±1σ, ±2σ)</span>
              </label>

              <div className="text-xs text-slate-500">
                {windowDays === 1
                  ? "Showing raw daily values. RTM anchors to the exact date; stocks use the nearest available trading day."
                  : `Stocks rolling uses last ${windowDays} available trading days. RTM rolling uses calendar days, lagged by ${lagClamped} days.`}
              </div>
            </div>

            {quickStats ? (
              <div className="mt-3 rounded-xl bg-white p-3 ring-1 ring-slate-200">
                <div className="text-xs font-semibold text-slate-700">Quick stats (latest in range)</div>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div className="text-sm text-slate-700">
                    <span className="text-slate-500">Chart date:</span>{" "}
                    <span className="font-semibold">{quickStats.displayDate}</span>
                    <div className="text-[11px] text-slate-500">
                      RTM computed at: <span className="font-semibold">{quickStats.rtmDate}</span>
                    </div>
                  </div>

                  <div className="text-sm text-slate-700">
                    <span className="text-slate-500">RTM ({periodLabel}):</span>{" "}
                    <span className="font-semibold">
                      {useLogScale ? (quickStats.rtm != null ? quickStats.rtm.toFixed(3) : "—") : fmtRtm(quickStats.rtm)}
                    </span>

                    {selectedStocks.length ? (
                      <div className="mt-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-slate-500">
                            {useLogScale ? "Log-Log Correlation (RTM vs Stock)" : "CORREL"}
                          </span>
                          <span
                            className={`font-semibold tabular-nums ${corrColorClass(
                              quickStats.corr?.[selectedStocks[0]] ?? null
                            )}`}
                          >
                            {fmtCorrDisplay(quickStats.corr?.[selectedStocks[0]] ?? null, useLogScale)}
                          </span>
                        </div>

                        {selectedStocks.slice(1).map((s) => (
                          <div key={`${s}-corr`} className="mt-1 flex items-center justify-between gap-2">
                            <span className="truncate text-slate-500">{s}</span>
                            <span className={`font-semibold tabular-nums ${corrColorClass(quickStats.corr?.[s] ?? null)}`}>
                              {fmtCorrDisplay(quickStats.corr?.[s] ?? null, useLogScale)}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {showYoY ? (
                      <div className="text-[11px] text-slate-500">
                        YoY: <span className="font-semibold">{fmtPct(quickStats.rtmYoY)}</span>
                      </div>
                    ) : null}
                  </div>

                  <div className="text-sm text-slate-700">
                    <span className="text-slate-500">Stocks ({periodLabel}):</span>
                    <div className="mt-1 space-y-1">
                      {selectedStocks.map((s) => (
                        <div key={s} className="flex items-center justify-between gap-2">
                          <span className="truncate">{s}</span>
                          <span className="font-semibold tabular-nums">
                            {useLogScale
                              ? (quickStats.stocks[s] != null ? (quickStats.stocks[s] as number).toFixed(3) : "—")
                              : fmtNum(quickStats.stocks[s])}
                          </span>
                        </div>
                      ))}
                    </div>

                    {showYoY ? (
                      <div className="mt-2 space-y-1 text-[11px] text-slate-500">
                        {selectedStocks.map((s) => (
                          <div key={`${s}-yoy`} className="flex items-center justify-between gap-2">
                            <span className="truncate">{s} YoY</span>
                            <span className="font-semibold tabular-nums">{fmtPct(quickStats.stocksYoY[s])}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <div className="lg:w-[360px] lg:shrink-0">
            <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
              <div className="text-xs font-semibold text-slate-700">Stocks</div>
              <div className="mt-2 max-h-[220px] overflow-auto rounded-xl bg-white ring-1 ring-slate-200">
                {stockUniverse.length ? (
                  <div className="grid grid-cols-1 gap-2 p-2 text-[12px] text-slate-700">
                    {stockUniverse.map((s) => {
                      const checked = selectedStocks.includes(s);
                      return (
                        <label key={s} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const on = e.target.checked;
                              setSelectedStocks((prev) => {
                                if (on) return Array.from(new Set([...prev, s]));
                                return prev.filter((x) => x !== s);
                              });
                            }}
                            className="h-4 w-4 rounded border-slate-300"
                          />
                          <span className="font-medium">{s}</span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <div className="p-3 text-sm text-slate-600">No columns found in active sheet.</div>
                )}
              </div>

              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedStocks(stockUniverse.slice(0, Math.min(1, stockUniverse.length)))}
                  className="rounded-lg bg-slate-900 px-2 py-1 text-[12px] font-semibold text-white hover:bg-slate-800"
                >
                  Pick top 1
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedStocks(stockUniverse.slice(0, Math.min(2, stockUniverse.length)))}
                  className="rounded-lg bg-white px-2 py-1 text-[12px] font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
                >
                  Pick top 2
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedStocks([])}
                  className="rounded-lg bg-white px-2 py-1 text-[12px] font-semibold text-rose-700 ring-1 ring-slate-200 hover:bg-slate-50"
                >
                  Clear
                </button>
              </div>
            </div>

            {/* ✅ Scatter-only toggle (shared state) */}
            <div className="mt-3 rounded-xl bg-white p-3 ring-1 ring-slate-200">
              <div className="text-xs font-semibold text-slate-700">Scatter options</div>
              <label className="mt-2 flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={showScatterEqn}
                  onChange={(e) => setShowScatterEqn(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                <span className="font-medium">Show regression equation</span>
              </label>
              <div className="mt-1 text-[11px] text-slate-500">
                When enabled, tooltip shows y = mx + b and R² for the hovered stock.
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-8">
        <div className="mt-6 grid grid-cols-1 gap-4">
          {/* =========================
              1) EXISTING DAILY CARD
          ========================== */}
          <Card title="RTM Vs Stocks (Daily Card)" right={titleRight}>
            {loading ? (
              <div className="text-sm text-slate-600">{loading}</div>
            ) : err ? (
              <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-200">{err}</div>
            ) : !anchorDate ? (
              <div className="text-sm text-slate-600">No stock data found (check stock.xlsx sheets & date column).</div>
            ) : (
              <>
                {ControlsAndStats}

                <div className="h-[380px] sm:h-[480px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 12, right: 42, bottom: 12, left: 42 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="label" tick={{ fontSize: 12 }} minTickGap={24} />

                      <YAxis
                        yAxisId="left"
                        width={92}
                        tickMargin={10}
                        tick={{ fontSize: 12 }}
                        tickFormatter={(v) => {
                          const n = asFiniteNumber(v);
                          if (n == null) return "—";
                          if (useLogScale) return n.toFixed(3);
                          return new Intl.NumberFormat("en-IN", {
                            maximumFractionDigits: 2,
                            minimumFractionDigits: 2
                          }).format(n);
                        }}
                        domain={[
                          (dataMin: number) => {
                            if (!Number.isFinite(dataMin)) return 0;
                            const pad = Math.abs(dataMin) * 0.05;
                            return dataMin - pad;
                          },
                          (dataMax: number) => {
                            if (!Number.isFinite(dataMax)) return 0;
                            const pad = Math.abs(dataMax) * 0.05;
                            return dataMax + pad;
                          }
                        ]}
                      />

                      <YAxis
                        yAxisId="right"
                        orientation="right"
                        width={92}
                        tickMargin={10}
                        tick={{ fontSize: 12 }}
                        tickFormatter={(v) => {
                          const n = asFiniteNumber(v);
                          if (n == null) return "—";
                          return useLogScale ? n.toFixed(3) : fmtNum(n);
                        }}
                        domain={[
                          (dataMin: number) => {
                            if (!Number.isFinite(dataMin)) return 0;
                            const pad = Math.abs(dataMin) * 0.05;
                            return dataMin - pad;
                          },
                          (dataMax: number) => {
                            if (!Number.isFinite(dataMax)) return 0;
                            const pad = Math.abs(dataMax) * 0.05;
                            return dataMax + pad;
                          }
                        ]}
                      />

                      <Tooltip
                        wrapperStyle={{ outline: "none" }}
                        formatter={(v: any, name: any, item: any) => {
                          const key = (item && (item.dataKey as string)) || (name as string);
                          const num = asFiniteNumber(v);

                          if (key === "rtm") {
                            return [
                              useLogScale ? `${(num ?? NaN).toFixed(3)} (log10)` : `${fmtRtm(num)} Rs/Unit`,
                              useLogScale
                                ? `RTM (log10 ${periodLabel}, lag ${lagClamped}d)`
                                : `RTM (${periodLabel}, lag ${lagClamped}d)`
                            ];
                          }

                          if (key === "rtm_yoy") return [fmtPct(num), "RTM YoY %"];

                          if (key.endsWith("_yoy")) {
                            const base = key.replace(/_yoy$/, "");
                            return [fmtPct(num), `${base} YoY %`];
                          }

                          if (selectedStocks.includes(key)) {
                            return [
                              useLogScale ? `${(num ?? NaN).toFixed(3)} (log10)` : fmtNum(num),
                              useLogScale
                                ? mode === "price"
                                  ? `${key} (log10 Price)`
                                  : `${key} (log10 P/B)`
                                : mode === "price"
                                  ? `${key} (Price)`
                                  : `${key} (P/B)`
                            ];
                          }

                          return [v, String(name)];
                        }}
                        labelFormatter={(l: any) => `Date: ${l}`}
                      />

                      <Legend />

                      {showRtmControlLines && rtmControl ? (
                        <>
                          <ReferenceLine
                            yAxisId="left"
                            y={rtmControl.mean}
                            stroke="#000000"
                            strokeWidth={CONTROL_STROKE_WIDTH}
                            strokeDasharray={CONTROL_DASH}
                            ifOverflow="extendDomain"
                            label={{
                              value: `Mean (${useLogScale ? rtmControl.mean.toFixed(3) : fmtRtm(rtmControl.mean)})`,
                              position: "insideTopLeft",
                              fontSize: 11,
                              fill: "#000000"
                            }}
                          />

                          <ReferenceLine
                            yAxisId="left"
                            y={rtmControl.p1}
                            stroke="#f97316"
                            strokeWidth={CONTROL_STROKE_WIDTH}
                            strokeDasharray={CONTROL_DASH}
                            ifOverflow="extendDomain"
                            label={{
                              value: `+1σ (${useLogScale ? rtmControl.p1.toFixed(3) : fmtRtm(rtmControl.p1)})`,
                              position: "insideTopLeft",
                              fontSize: 11,
                              fill: "#f97316"
                            }}
                          />

                          <ReferenceLine
                            yAxisId="left"
                            y={rtmControl.p2}
                            stroke="#16a34a"
                            strokeWidth={CONTROL_STROKE_WIDTH}
                            strokeDasharray={CONTROL_DASH}
                            ifOverflow="extendDomain"
                            label={{
                              value: `+2σ (${useLogScale ? rtmControl.p2.toFixed(3) : fmtRtm(rtmControl.p2)})`,
                              position: "insideTopLeft",
                              fontSize: 11,
                              fill: "#16a34a"
                            }}
                          />

                          <ReferenceLine
                            yAxisId="left"
                            y={rtmControl.m1}
                            stroke="#b45309"
                            strokeWidth={CONTROL_STROKE_WIDTH}
                            strokeDasharray={CONTROL_DASH}
                            ifOverflow="extendDomain"
                            label={{
                              value: `-1σ (${useLogScale ? rtmControl.m1.toFixed(3) : fmtRtm(rtmControl.m1)})`,
                              position: "insideBottomLeft",
                              fontSize: 11,
                              fill: "#b45309"
                            }}
                          />

                          <ReferenceLine
                            yAxisId="left"
                            y={rtmControl.m2}
                            stroke="#7c3aed"
                            strokeWidth={CONTROL_STROKE_WIDTH}
                            strokeDasharray={CONTROL_DASH}
                            ifOverflow="extendDomain"
                            label={{
                              value: `-2σ (${useLogScale ? rtmControl.m2.toFixed(3) : fmtRtm(rtmControl.m2)})`,
                              position: "insideBottomLeft",
                              fontSize: 11,
                              fill: "#7c3aed"
                            }}
                          />
                        </>
                      ) : null}

                      <Line
                        yAxisId="left"
                        type="monotone"
                        dataKey="rtm"
                        name={`RTM${useLogScale ? " (log10)" : " (Rs/Unit)"}${lagClamped ? ` (lag ${lagClamped}d)` : ""}`}
                        dot={false}
                        strokeWidth={2}
                        stroke="#dc2626"
                        connectNulls
                      />

                      {selectedStocks.map((s, i) => (
                        <Line
                          key={s}
                          yAxisId="right"
                          type="monotone"
                          dataKey={s}
                          name={
                            useLogScale
                              ? mode === "price"
                                ? `${s} (log10 Price)`
                                : `${s} (log10 P/B)`
                              : mode === "price"
                                ? `${s} (Price)`
                                : `${s} (P/B)`
                          }
                          dot={false}
                          strokeWidth={2}
                          stroke={getStockColor(i)}
                          connectNulls
                        />
                      ))}

                      {showYoY ? (
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="rtm_yoy"
                          name="RTM YoY %"
                          dot={false}
                          strokeWidth={2}
                          stroke="#16a34a"
                          connectNulls
                        />
                      ) : null}
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                <div className="mt-2 text-[11px] text-slate-500">
                  Stocks are computed on chart date range ending at{" "}
                  <span className="font-semibold">{range.toIso ? formatDDMMYYYY(range.toIso) : "—"}</span>. RTM is computed
                  using a lagged anchor (To − {lagClamped}d) ending at{" "}
                  <span className="font-semibold">{rtmAnchor ? formatDDMMYYYY(rtmAnchor) : "—"}</span>.
                </div>
              </>
            )}
          </Card>

          {/* =========================
              2) NEW SECOND DAILY CARD (SCATTER)
          ========================== */}
          <Card title="RTM Vs Stocks (Daily Card – Scatter)" right={titleRight}>
            {loading ? (
              <div className="text-sm text-slate-600">{loading}</div>
            ) : err ? (
              <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-200">{err}</div>
            ) : !anchorDate ? (
              <div className="text-sm text-slate-600">No stock data found (check stock.xlsx sheets & date column).</div>
            ) : (
              <>
                {ControlsAndStats}

                <div className="h-[380px] sm:h-[480px]">
                  <ResponsiveContainer width="100%" height="100%">
                    {/* ✅ extra bottom space so Legend doesn't cover X-axis label */}
                    <ScatterChart margin={{ top: 12, right: 42, bottom: 44, left: 42 }}>
                      <CartesianGrid strokeDasharray="3 3" />

                      <XAxis
                        type="number"
                        dataKey="x"
                        name={`RTM (${periodLabel})`}
                        tick={{ fontSize: 12 }}
                        tickFormatter={(v) => {
                          const n = asFiniteNumber(v);
                          if (n == null) return "—";
                          return useLogScale ? n.toFixed(3) : fmtRtm(n);
                        }}
                        domain={scatterDomains.x}
                        label={{
                          value: useLogScale
                            ? `RTM (log10 ${periodLabel})${lagClamped ? ` (lag ${lagClamped}d)` : ""}`
                            : `RTM (${periodLabel}) ₹/unit${lagClamped ? ` (lag ${lagClamped}d)` : ""}`,
                          position: "insideBottom",
                          offset: -10,
                          fontSize: 12
                        }}
                      />

                      <YAxis
                        type="number"
                        dataKey="y"
                        name={`Stock (${periodLabel})`}
                        tick={{ fontSize: 12 }}
                        tickFormatter={(v) => {
                          const n = asFiniteNumber(v);
                          if (n == null) return "—";
                          return useLogScale ? n.toFixed(3) : fmtNum(n);
                        }}
                        domain={scatterDomains.y}
                        label={{
                          value: useLogScale
                            ? mode === "price"
                              ? `Stock (log10 ${periodLabel}) Price`
                              : `Stock (log10 ${periodLabel}) P/B`
                            : mode === "price"
                              ? `Stock (${periodLabel}) Price`
                              : `Stock (${periodLabel}) P/B`,
                          angle: -90,
                          position: "insideLeft",
                          fontSize: 12
                        }}
                      />

                      <Tooltip
                        wrapperStyle={{ outline: "none" }}
                        content={({ active, payload }) => {
                          if (!active || !payload || !payload.length) return null;

                          // ✅ Robust: pick the hovered scatter point payload (Recharts can send multiple payload items)
                          const hovered = (payload as any[]).find((it: any) => it?.payload?.stock) || payload[0];
                          const p: any = (hovered as any)?.payload;

                          const stockName: string = p?.stock || "";
                          const reg = stockName ? regressionByStock[stockName] : null;

                          return (
                            <div className="rounded-xl bg-white p-3 text-xs text-slate-700 shadow-md ring-1 ring-slate-200">
                              <div className="font-semibold">
                                {stockName ? `${stockName} · ` : ""}
                                Date: {p?.dateLabel ?? "—"}
                              </div>
                              <div className="mt-1">
                                <span className="text-slate-500">RTM (X):</span>{" "}
                                <span className="font-semibold">
                                  {useLogScale ? (asFiniteNumber(p?.x) ?? NaN).toFixed(3) : fmtRtm(asFiniteNumber(p?.x))}
                                </span>
                              </div>
                              <div className="mt-1">
                                <span className="text-slate-500">{stockName || "Stock"} (Y):</span>{" "}
                                <span className="font-semibold">
                                  {useLogScale ? (asFiniteNumber(p?.y) ?? NaN).toFixed(3) : fmtNum(asFiniteNumber(p?.y))}
                                </span>
                              </div>

                              {showScatterEqn && reg ? (
                                <div className="mt-2 rounded-lg bg-slate-50 p-2 ring-1 ring-slate-200">
                                  <div className="text-slate-500">Regression</div>
                                  <div className="font-semibold">{fmtEqn(reg.slope, reg.intercept)}</div>
                                  <div className="mt-1">
                                    <span className="text-slate-500">R²:</span>{" "}
                                    <span className="font-semibold">{fmtR2(reg.r2)}</span>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          );
                        }}
                      />

                      <Legend
                        verticalAlign="bottom"
                        align="center"
                        wrapperStyle={{ paddingTop: 10, transform: "translateY(12px)" }}
                        formatter={(value: any) => {
                          const s = String(value);
                          const reg = regressionByStock[s];
                          if (reg && reg.r2 != null) return `${s} (R² = ${fmtR2(reg.r2)})`;
                          return s;
                        }}
                      />

                      {/* ✅ Trend lines per stock (dashed) */}
                      {selectedStocks.map((s, i) => {
                        const reg = regressionByStock[s];
                        if (!reg || !reg.line?.length) return null;

                        const p1 = reg.line[0];
                        const p2 = reg.line[1];

                        return (
                          <ReferenceLine
                            key={`ref-tl-${s}`}
                            segment={[
                              { x: p1.x, y: p1.y },
                              { x: p2.x, y: p2.y }
                            ]}
                            stroke={getStockColor(i)}
                            strokeWidth={2}
                            strokeDasharray="6 6" // ✅ dashed trendline
                            ifOverflow="extendDomain"
                          />
                        );
                      })}

                      {/* Scatter series per stock */}
                      {selectedStocks.map((s, i) => (
                        <Scatter key={`sc-${s}`} name={s} data={scatterByStock[s] || []} fill={getStockColor(i)} />
                      ))}

                      {/* (kept) Old Line trend attempt - harmless, but ReferenceLine above is the real trendline */}
                      {selectedStocks.map((s, i) => {
                        const reg = regressionByStock[s];
                        if (!reg || !reg.line?.length) return null;
                        return (
                          <Line
                            key={`tl-${s}`}
                            type="linear"
                            data={reg.line}
                            dataKey="y"
                            dot={false}
                            strokeWidth={2}
                            stroke={getStockColor(i)}
                            legendType="none"
                            isAnimationActive={false}
                          />
                        );
                      })}
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>

                <div className="mt-2 text-[11px] text-slate-500">
                  Each dot is one date in the selected range.{" "}
                  {useLogScale ? (
                    <>
                      X = log10(RTM {periodLabel}, lagged by {lagClamped}d). Y = log10(stock {periodLabel}{" "}
                      {mode === "price" ? "Price" : "P/B"}).
                    </>
                  ) : (
                    <>
                      X = RTM {periodLabel} (lagged by {lagClamped}d). Y = stock {periodLabel} ({mode === "price" ? "Price" : "P/B"}).
                    </>
                  )}{" "}
                  Trend lines are linear best-fit lines; legend shows R².
                </div>
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
