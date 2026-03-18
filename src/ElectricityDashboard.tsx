import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/* -----------------------------
   Helpers
----------------------------- */

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function parseISOKey(s: string) {
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!ok) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : s;
}

// ✅ Universal date parser
// Accepts ALL formats:
// DD/MM/YYYY, DD/MM/YY, MM/YYYY, MM/YY,
// DD-MM-YYYY, DD-MM-YY,
// ISO YYYY-MM-DD
//
// Month-only formats are normalized to FIRST DAY of month (YYYY-MM-01).
function parseInputDate(s: unknown) {
  if (typeof s !== "string") return null;
  const t = s.trim();

  let m: RegExpMatchArray | null;

  // DD/MM/YYYY
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = Number(m[3]);
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (
      !Number.isNaN(d.getTime()) &&
      d.getUTCFullYear() === yyyy &&
      d.getUTCMonth() === mm - 1 &&
      d.getUTCDate() === dd
    ) {
      return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
    return null;
  }

  // DD/MM/YY -> 20YY
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = 2000 + Number(m[3]);
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (
      !Number.isNaN(d.getTime()) &&
      d.getUTCFullYear() === yyyy &&
      d.getUTCMonth() === mm - 1 &&
      d.getUTCDate() === dd
    ) {
      return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
    return null;
  }

  // MM/YYYY -> YYYY-MM-01
  m = t.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mm = Number(m[1]);
    const yyyy = Number(m[2]);
    if (Number.isFinite(mm) && mm >= 1 && mm <= 12 && Number.isFinite(yyyy) && yyyy >= 1900) {
      return `${yyyy}-${String(mm).padStart(2, "0")}-01`;
    }
    return null;
  }

  // MM/YY -> 20YY-MM-01
  m = t.match(/^(\d{1,2})\/(\d{2})$/);
  if (m) {
    const mm = Number(m[1]);
    const yyyy = 2000 + Number(m[2]);
    if (Number.isFinite(mm) && mm >= 1 && mm <= 12) {
      return `${yyyy}-${String(mm).padStart(2, "0")}-01`;
    }
    return null;
  }

  // DD-MM-YYYY
  m = t.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = Number(m[3]);
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (
      !Number.isNaN(d.getTime()) &&
      d.getUTCFullYear() === yyyy &&
      d.getUTCMonth() === mm - 1 &&
      d.getUTCDate() === dd
    ) {
      return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
    return null;
  }

  // DD-MM-YY -> 20YY
  m = t.match(/^(\d{1,2})-(\d{1,2})-(\d{2})$/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = 2000 + Number(m[3]);
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (
      !Number.isNaN(d.getTime()) &&
      d.getUTCFullYear() === yyyy &&
      d.getUTCMonth() === mm - 1 &&
      d.getUTCDate() === dd
    ) {
      return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
    return null;
  }

  // ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return parseISOKey(t);

  return null;
}

function formatDDMMYYYY(iso: string) {
  // UI display format stays dd-mm-yyyy (no UI change)
  if (!iso || typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

// ✅ CSV standard output: dd/mm/yyyy
function formatDDMMYYYYForCSV(iso: string) {
  if (!iso || typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function formatDDMMYY(iso: string) {
  if (!iso || typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y.slice(2)}`;
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

// Week starts Monday
function startOfWeekISO(iso: string) {
  const d = new Date(iso + "T00:00:00Z");
  const dow = d.getUTCDay(); // 0=Sun,1=Mon...
  const diffToMon = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diffToMon);
  return d.toISOString().slice(0, 10);
}

function monthKey(isoDate: string) {
  return isoDate.slice(0, 7); // YYYY-MM
}

function addMonths(ym: string, delta: number) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getYear(ym: string) {
  return Number(ym.slice(0, 4));
}

function getMonth(ym: string) {
  return Number(ym.slice(5, 7));
}

function safeDiv(n: number, d: number | null | undefined) {
  if (d == null || d === 0) return null;
  return n / d;
}

function growthPct(curr: number, prev: number) {
  const r = safeDiv(curr - prev, prev);
  return r == null ? null : r * 100;
}

function sortISO(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function computeDomain(values: Array<number | null | undefined>, padPct = 0.05, minAbsPad = 1) {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return undefined;
  let min = Math.min(...nums);
  let max = Math.max(...nums);
  if (min === max) {
    const pad = Math.max(minAbsPad, Math.abs(min) * padPct);
    return [min - pad, max + pad] as [number, number];
  }
  const range = max - min;
  const pad = Math.max(minAbsPad, range * padPct);
  return [min - pad, max + pad] as [number, number];
}

function pctColorClass(x: number | null | undefined) {
  if (x == null || Number.isNaN(x)) return "text-slate-500";
  if (x > 0) return "text-emerald-700";
  if (x < 0) return "text-rose-700";
  return "text-slate-600";
}

/* -----------------------------
   CSV parsing
   - Accepts:
     1) legacy: date,<value> with any 2nd column name
     2) new: date,total,coal,renewable (and more columns)
   - Reads column based on valueColumnKey if header exists
----------------------------- */

function normalizeKey(s: string) {
  return (s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/–/g, "-")
    .replace(/—/g, "-");
}

function csvParse(text: string, valueColumnKey: string) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const rows: string[][] = [];
  for (const line of lines) {
    const cols = line.split(",").map((c) => c.trim());
    if (cols.length >= 2) rows.push(cols);
  }

  // empty
  if (!rows.length) return { parsed: [] as Array<{ date: string; value: number }>, errors: [] as string[] };

  // Optional header: if col0 contains "date", drop it and locate value column
  let valueIdx = 1; // fallback legacy: 2nd col
  const h0 = (rows[0][0] || "").toLowerCase();
  const hasHeader = h0.includes("date");

  if (hasHeader) {
    const header = rows[0].map((h) => normalizeKey(h));
    const want = normalizeKey(valueColumnKey);
    const found = header.indexOf(want);
    if (found !== -1) valueIdx = found;
    rows.shift();
  }

  const parsed: Array<{ date: string; value: number }> = [];
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const dRaw = row[0];
    const vRaw = row[valueIdx] ?? row[1] ?? "";

    const date = parseInputDate(dRaw);
    const v = Number(String(vRaw).replace(/,/g, ""));

    if (!date) {
      errors.push(`Row ${i + 1}: invalid date '${dRaw}' (expected DD/MM/YYYY)`);
      continue;
    }
    if (!Number.isFinite(v)) {
      errors.push(`Row ${i + 1}: invalid value '${vRaw}'`);
      continue;
    }
    parsed.push({ date, value: v });
  }

  return { parsed, errors };
}

function sampleCSV(valueColumnKey: string) {
  // ✅ sample uses dd/mm/yyyy
  return [`date,${valueColumnKey}`, "18/12/2025,10", "19/12/2025,11", "20/12/2025,12"].join("\n");
}

function downloadCSV(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function mergeRecords(existingMap: Map<string, number>, incoming: Array<{ date: string; value: number }>) {
  const next = new Map(existingMap);
  for (const r of incoming) next.set(r.date, r.value);
  return next;
}

/* -----------------------------
   Aggregation structures
----------------------------- */

type DailyPoint = { date: string; value: number };

type DailyChartPoint = {
  label: string;
  units: number;
  prev_year_units: number | null;
  yoy_pct: number | null;
  mom_pct: number | null; // weekly rolling: WoW%, monthly: MoM%
};

// Month map with sum+count (for avg mode)
function buildMonthAggMap(sortedDaily: DailyPoint[]) {
  const map = new Map<
    string,
    { sum: number; count: number; maxDay: number; byDaySum: Map<number, number>; byDayCount: Map<number, number> }
  >();

  for (const d of sortedDaily) {
    const m = monthKey(d.date);
    const day = Number(d.date.slice(8, 10));
    if (!map.has(m)) {
      map.set(m, { sum: 0, count: 0, maxDay: 0, byDaySum: new Map(), byDayCount: new Map() });
    }
    const rec = map.get(m)!;
    rec.sum += d.value;
    rec.count += 1;
    rec.maxDay = Math.max(rec.maxDay, day);
    rec.byDaySum.set(day, (rec.byDaySum.get(day) || 0) + d.value);
    rec.byDayCount.set(day, (rec.byDayCount.get(day) || 0) + 1);
  }

  return map;
}

function sumMonthUpToDay(monthRec: { byDaySum: Map<number, number> } | undefined, dayLimit: number) {
  if (!monthRec) return null;
  let s = 0;
  let hasAny = false;
  for (let day = 1; day <= dayLimit; day++) {
    const v = monthRec.byDaySum.get(day);
    if (v != null) {
      s += v;
      hasAny = true;
    }
  }
  return hasAny ? s : null;
}

function avgMonthFull(monthRec: { sum: number; count: number } | undefined) {
  if (!monthRec || !monthRec.count) return null;
  return monthRec.sum / monthRec.count;
}

function toMonthlySumComparable(sortedDaily: DailyPoint[]) {
  // sum mode monthly logic with comparable day-window
  const monthMap = buildMonthAggMap(sortedDaily);
  const months = Array.from(monthMap.keys()).sort(sortISO);

  const out = months.map((m) => ({
    month: m,
    value: monthMap.get(m)!.sum,
    max_day: monthMap.get(m)!.maxDay,
    yoy_pct: null as number | null,
    mom_pct: null as number | null,
  }));

  for (const r of out) {
    const prevMonth = addMonths(r.month, -1);
    const prevMonthRec = monthMap.get(prevMonth);
    const prevComparableMoM = sumMonthUpToDay(prevMonthRec, r.max_day);
    r.mom_pct = prevComparableMoM != null ? growthPct(r.value, prevComparableMoM) : null;

    const prevYearMonth = `${getYear(r.month) - 1}-${String(getMonth(r.month)).padStart(2, "0")}`;
    const prevYearRec = monthMap.get(prevYearMonth);
    const prevComparableYoY = sumMonthUpToDay(prevYearRec, r.max_day);
    r.yoy_pct = prevComparableYoY != null ? growthPct(r.value, prevComparableYoY) : null;
  }

  return out;
}

function toMonthlyAvgFull(sortedDaily: DailyPoint[]) {
  // avg mode: full month average; YoY vs full month last year avg; MoM vs previous month avg
  const monthMap = buildMonthAggMap(sortedDaily);
  const months = Array.from(monthMap.keys()).sort(sortISO);

  return months.map((m) => {
    const currAvg = avgMonthFull(monthMap.get(m)) ?? 0;

    const prevMonth = addMonths(m, -1);
    const prevAvg = avgMonthFull(monthMap.get(prevMonth));

    const prevYearMonth = `${getYear(m) - 1}-${String(getMonth(m)).padStart(2, "0")}`;
    const prevYearAvg = avgMonthFull(monthMap.get(prevYearMonth));

    return {
      month: m,
      value: currAvg,
      yoy_pct: prevYearAvg != null ? growthPct(currAvg, prevYearAvg) : null,
      mom_pct: prevAvg != null ? growthPct(currAvg, prevAvg) : null,
    };
  });
}

/* -----------------------------
   KPIs
----------------------------- */

function computeKPIs(sortedDaily: DailyPoint[], calcMode: "sum" | "avg") {
  if (sortedDaily.length === 0) {
    return {
      latest: null as DailyPoint | null,
      latestYoY: null as number | null,
      avg7: null as number | null,
      avg7YoY: null as number | null,
      avg30: null as number | null,
      avg30YoY: null as number | null,
      ytdValue: null as number | null,
      ytdYoY: null as number | null,
      mtdAvg: null as number | null,
      mtdYoY: null as number | null,
    };
  }

  const dailyLookup = new Map(sortedDaily.map((d) => [d.date, d.value] as const));
  const latest = sortedDaily[sortedDaily.length - 1];

  const isoAddYears = (iso: string, deltaYears: number) => {
    const y = Number(iso.slice(0, 4));
    const m = Number(iso.slice(5, 7));
    const d = Number(iso.slice(8, 10));
    const tryDt = new Date(Date.UTC(y + deltaYears, m - 1, d));
    if (
      tryDt.getUTCFullYear() === y + deltaYears &&
      tryDt.getUTCMonth() === m - 1 &&
      tryDt.getUTCDate() === d
    )
      return tryDt.toISOString().slice(0, 10);
    const lastDay = new Date(Date.UTC(y + deltaYears, m, 0));
    return lastDay.toISOString().slice(0, 10);
  };

  const sumCountInclusive = (startIso: string, endIso: string) => {
    if (startIso > endIso) return { sum: null as number | null, count: 0 };
    let sum = 0;
    let count = 0;
    let cur = startIso;
    while (cur <= endIso) {
      const v = dailyLookup.get(cur);
      if (v != null) {
        sum += v;
        count += 1;
      }
      cur = isoPlusDays(cur, 1);
    }
    return { sum: count ? sum : null, count };
  };

  const avgForLastNDaysEnding = (endIso: string, nDays: number) => {
    const startIso = isoMinusDays(endIso, nDays - 1);
    const { sum, count } = sumCountInclusive(startIso, endIso);
    return { startIso, endIso, avg: sum != null && count ? sum / count : null };
  };

  // Latest YoY (same date)
  const prevYearDate = isoAddYears(latest.date, -1);
  const prevYearVal = dailyLookup.get(prevYearDate) ?? null;
  const latestYoY = prevYearVal != null ? growthPct(latest.value, prevYearVal) : null;

  // 7d avg + YoY on avg
  const last7 = avgForLastNDaysEnding(latest.date, 7);
  const py7 = sumCountInclusive(isoAddYears(last7.startIso, -1), isoAddYears(last7.endIso, -1));
  const avg7 = last7.avg;
  const avg7PY = py7.sum != null && py7.count ? py7.sum / py7.count : null;
  const avg7YoY = avg7 != null && avg7PY != null ? growthPct(avg7, avg7PY) : null;

  // 30d avg + YoY on avg
  const last30 = avgForLastNDaysEnding(latest.date, 30);
  const py30 = sumCountInclusive(isoAddYears(last30.startIso, -1), isoAddYears(last30.endIso, -1));
  const avg30 = last30.avg;
  const avg30PY = py30.sum != null && py30.count ? py30.sum / py30.count : null;
  const avg30YoY = avg30 != null && avg30PY != null ? growthPct(avg30, avg30PY) : null;

  // FY window
  const latestY = Number(latest.date.slice(0, 4));
  const latestM = Number(latest.date.slice(5, 7));
  const fyStartYear = latestM >= 4 ? latestY : latestY - 1;
  const ytdStart = `${fyStartYear}-04-01`;

  const ytd = sumCountInclusive(ytdStart, latest.date);

  const ytdPYStart = `${fyStartYear - 1}-04-01`;
  const ytdPYEnd = isoAddYears(latest.date, -1);
  const ytdPY = sumCountInclusive(ytdPYStart, ytdPYEnd);

  // SUM tabs: show YTD total
  // AVG tabs: show YTD average daily
  const ytdValue = calcMode === "sum" ? ytd.sum : ytd.sum != null && ytd.count ? ytd.sum / ytd.count : null;

  const ytdValuePY =
    calcMode === "sum"
      ? ytdPY.sum
      : ytdPY.sum != null && ytdPY.count
        ? ytdPY.sum / ytdPY.count
        : null;

  const ytdYoY = ytdValue != null && ytdValuePY != null ? growthPct(ytdValue, ytdValuePY) : null;

  // MTD avg (always avg)
  const thisMonthStart = `${latest.date.slice(0, 7)}-01`;
  const mtd = sumCountInclusive(thisMonthStart, latest.date);
  const mtdAvg = mtd.sum != null && mtd.count ? mtd.sum / mtd.count : null;

  const mtdPY = sumCountInclusive(isoAddYears(thisMonthStart, -1), isoAddYears(latest.date, -1));
  const mtdAvgPY = mtdPY.sum != null && mtdPY.count ? mtdPY.sum / mtdPY.count : null;
  const mtdYoY = mtdAvg != null && mtdAvgPY != null ? growthPct(mtdAvg, mtdAvgPY) : null;

  return {
    latest,
    latestYoY,
    avg7,
    avg7YoY,
    avg30,
    avg30YoY,
    ytdValue,
    ytdYoY,
    mtdAvg,
    mtdYoY,
  };
}

/* -----------------------------
   UI Components
----------------------------- */

function Card({
  title,
  children,
  right,
}: {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
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

function Stat({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">{value}</div>
      {sub ? <div className="mt-1">{sub}</div> : null}
    </div>
  );
}

function YoYSub({ value, suffix = "YoY" }: { value: number | null | undefined; suffix?: string }) {
  return (
    <div className={`text-sm font-semibold ${pctColorClass(value)} tabular-nums`}>
      {value == null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`}{" "}
      <span className="font-semibold">{suffix}</span>
    </div>
  );
}

/* -----------------------------
   Main Component
----------------------------- */

export type ElectricityDashboardProps = {
  type: string;
  title: string;
  subtitle: string;
  seriesLabel: string;
  unitLabel: string;
  valueColumnKey: string;
  defaultCsvPath: string;
  enableAutoFetch?: boolean;
  calcMode: "sum" | "avg";
  valueDisplay: { suffix: string; decimals: number };
  extraBadgeCols?: { key: string; label: string; isText?: boolean }[];
  extraBadgeCsvPath?: string;
  hideMainBadge?: boolean;
};

// explicit view types
type ViewAs =
  | "rolling45_avg"
  | "rolling30_avg"
  | "rolling14_avg"
  | "daily"
  | "weekly_roll7_avg"
  | "monthly"
  | "rolling30_sum";

export default function ElectricityDashboard(props: ElectricityDashboardProps) {
  const {
    type,
    title,
    subtitle,
    seriesLabel,
    unitLabel,
    valueColumnKey,
    defaultCsvPath,
    enableAutoFetch = false,
    calcMode,
    valueDisplay,
    extraBadgeCols,
    extraBadgeCsvPath,
    hideMainBadge,
  } = props;

  const STORAGE_KEY = `tusk_india_${type}_v1`;
  const isSumTab = calcMode === "sum";
  const isAvgTab = calcMode === "avg";
  const isPeakDemandTab = type === "demand"; // ✅ Peak Demand Met tab identifier

  const fmtValue = (x: number | null | undefined) => {
    if (x == null || Number.isNaN(x)) return "—";
    const rounded = Number(x.toFixed(valueDisplay.decimals));
    return `${new Intl.NumberFormat("en-IN", {
      minimumFractionDigits: valueDisplay.decimals,
      maximumFractionDigits: valueDisplay.decimals,
    }).format(rounded)}${valueDisplay.suffix}`;
  };

  const fmtPct = (x: number | null | undefined) => {
    if (x == null || Number.isNaN(x)) return "—";
    const sign = x > 0 ? "+" : "";
    const rounded = Number(x.toFixed(2));
    return `${sign}${rounded.toFixed(2)}%`;
  };

  const [dataMap, setDataMap] = useState<Map<string, number>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return new Map();
      const obj = JSON.parse(raw);
      const entries = Object.entries(obj || {});
      const m = new Map<string, number>();
      for (const [k, v] of entries) {
        const d = parseISOKey(k);
        const n = Number(v);
        if (d && Number.isFinite(n)) m.set(d, n);
      }
      return m;
    } catch {
      return new Map();
    }
  });

  const [date, setDate] = useState(() => {
    const t = new Date();
    const dd = String(t.getDate()).padStart(2, "0");
    const mm = String(t.getMonth() + 1).padStart(2, "0");
    const yyyy = t.getFullYear();
    // keep existing default input format for UI (dd-mm-yyyy)
    return `${dd}-${mm}-${yyyy}`;
  });

  const [valueText, setValueText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  // default "24 Months" ON for all tabs
  const [rangeDays, setRangeDays] = useState(730);

  const [fetchStatus, setFetchStatus] = useState<string | null>(null);
  const [extraLatestValues, setExtraLatestValues] = useState<Map<string, number>>(new Map());
  const [extraTextValues, setExtraTextValues] = useState<Map<string, string>>(new Map());
  const [extraBadgeLatestValues, setExtraBadgeLatestValues] = useState<Map<string, number>>(new Map());
  const [extraBadgeTextValues, setExtraBadgeTextValues] = useState<Map<string, string>>(new Map());
  const [textByDate, setTextByDate] = useState<Map<string, Map<string, string>>>(new Map());

  const [fromIso, setFromIso] = useState("");
  const [toIso, setToIso] = useState("");

  // Default View as: rolling avg (first option)
  const [aggFreq, setAggFreq] = useState<ViewAs>("rolling30_avg");

  /* =========================================================
     ✅ DEFAULT TOGGLE STATES
     Requirement:
     - Peak Demand Met tab (type === "demand"): YoY% only ON + control lines ON
       (AVG Current OFF by default for this tab)
     - Other SUM tabs: YoY% only ON + control lines ON
     - Other AVG tabs: AVG Current ON + control lines ON
  ========================================================= */

  const [showUnitsSeries, setShowUnitsSeries] = useState<boolean>(() => {
    // Peak Demand Met: YoY% only by default => totals OFF
    if (isPeakDemandTab) return false;

    // Other AVG tabs: "AVG current" ON by default
    // SUM tabs: totals OFF by default (YoY% only)
    return isAvgTab;
  });

  const [showPrevYearSeries, setShowPrevYearSeries] = useState<boolean>(() => {
    // always OFF by default for all tabs
    return false;
  });

  const [showYoYSeries, setShowYoYSeries] = useState<boolean>(() => {
    // Peak Demand Met: YoY ON by default
    if (isPeakDemandTab) return true;

    // Other SUM tabs: YoY ON by default
    // Other AVG tabs: YoY OFF by default
    return isSumTab;
  });

  const [showMoMSeries, setShowMoMSeries] = useState<boolean>(() => {
    // always OFF by default
    return false;
  });

  const [showControlLines, setShowControlLines] = useState<boolean>(() => {
    // always ON by default
    return true;
  });

  const [tablePeriod, setTablePeriod] = useState<"monthly" | "weekly" | "yearly">("monthly");

  const fileRef = useRef<HTMLInputElement | null>(null);

  // Ensure defaults apply on open/reload AND remain correct if component ever re-mounts
  useEffect(() => {
    // Peak Demand Met tab: YoY% only + control lines ON
    if (isPeakDemandTab) {
      setShowUnitsSeries(false);
      setShowPrevYearSeries(false);
      setShowYoYSeries(true);
      setShowMoMSeries(false);
      setShowControlLines(true);
      return;
    }

    // Other SUM tabs -> YoY only + control lines ON
    if (isSumTab) {
      setShowUnitsSeries(false);
      setShowPrevYearSeries(false);
      setShowYoYSeries(true);
      setShowMoMSeries(false);
      setShowControlLines(true);
      return;
    }

    // Other AVG tabs -> AVG current + control lines ON
    setShowUnitsSeries(true);
    setShowPrevYearSeries(false);
    setShowYoYSeries(false);
    setShowMoMSeries(false);
    setShowControlLines(true);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once per tab instance

  useEffect(() => {
    document.title = title;
  }, [title]);

  // Load CSV from public path
  useEffect(() => {
    let cancelled = false;

    async function loadDefaultCSV() {
      try {
        const url = `${encodeURI(defaultCsvPath)}?v=${Date.now()}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();

        const { parsed, errors: errs } = csvParse(text, valueColumnKey);
        if (cancelled) return;

        if (!parsed.length) {
          setErrors((prev) => (prev.length ? prev : [`Default CSV loaded but no valid rows found for ${type}.`]));
          return;
        }

        const m = new Map<string, number>();
        for (const r of parsed) m.set(r.date, r.value);

        setDataMap(m);

        // Parse extra badge columns from the same CSV
        if (extraBadgeCols?.length) {
          const extra = new Map<string, number>();
          const textExtra = new Map<string, string>();

          // Build header index from first non-empty line
          const rawLines = text.split("\n").filter((l) => l.trim());
          const headerCols = rawLines.length
            ? rawLines[0].split(",").map((h) => h.trim())
            : [];
          const lastRawCols = rawLines.length
            ? rawLines[rawLines.length - 1].split(",")
            : [];

          for (const { key, isText } of extraBadgeCols) {
            if (isText) {
              // Read raw string value from last data row
              const ci = headerCols.indexOf(key);
              if (ci >= 0 && lastRawCols[ci] != null) {
                textExtra.set(key, lastRawCols[ci].trim());
              }
            } else {
              const { parsed: ep } = csvParse(text, key);
              if (ep.length) extra.set(key, ep[ep.length - 1].value);
            }
          }

          // Build per-date text lookup for tooltip (all rows)
          const textColIndices: Array<[string, number]> = [];
          for (const { key, isText } of extraBadgeCols) {
            if (isText) {
              const ci = headerCols.indexOf(key);
              if (ci >= 0) textColIndices.push([key, ci]);
            }
          }
          if (textColIndices.length) {
            const byDate = new Map<string, Map<string, string>>();
            for (let i = 1; i < rawLines.length; i++) {
              const cols = rawLines[i].split(",");
              const rawDate = cols[0]?.trim();
              if (!rawDate) continue;
              const isoDate = parseInputDate(rawDate);
              if (!isoDate) continue;
              const dayLabel = formatDDMMYYYY(isoDate);
              const entry = new Map<string, string>();
              for (const [key, ci] of textColIndices) {
                if (cols[ci] != null) entry.set(key, cols[ci].trim());
              }
              byDate.set(dayLabel, entry);
            }
            if (!cancelled) setTextByDate(byDate);
          }

          if (!cancelled) {
            setExtraLatestValues(extra);
            setExtraTextValues(textExtra);
          }
        }

        if (errs.length) {
          setFetchStatus(`Loaded (${parsed.length} rows) with ${errs.length} issues.`);
        } else {
          setFetchStatus(`Loaded (${parsed.length} rows).`);
        }
      } catch {
        if (!cancelled) {
          setErrors((prev) => (prev.length ? prev : [`Could not load default CSV (${defaultCsvPath}).`]));
        }
      }
    }

    loadDefaultCSV();
    return () => {
      cancelled = true;
    };
  }, [defaultCsvPath, type, valueColumnKey]);

  // Secondary badge CSV fetch — reads last row from a different CSV than the main data
  useEffect(() => {
    if (!extraBadgeCsvPath || !extraBadgeCols?.length) return;
    let cancelled = false;
    fetch(extraBadgeCsvPath)
      .then((r) => r.text())
      .then((text) => {
        if (cancelled) return;
        const rawLines = text.split("\n").filter((l) => l.trim());
        if (!rawLines.length) return;
        const headerCols = rawLines[0].split(",").map((c) => c.trim().toLowerCase());
        const lastLine = rawLines[rawLines.length - 1].split(",");
        const latestVals = new Map<string, number>();
        const textVals = new Map<string, string>();
        for (const { key, isText } of extraBadgeCols) {
          const ci = headerCols.indexOf(key.toLowerCase());
          if (ci < 0) continue;
          const raw = lastLine[ci]?.trim() ?? "";
          if (isText) {
            textVals.set(key, raw);
          } else {
            const n = parseFloat(raw);
            if (!isNaN(n)) latestVals.set(key, n);
          }
        }
        setExtraBadgeLatestValues(latestVals);
        setExtraBadgeTextValues(textVals);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [extraBadgeCsvPath]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const obj = Object.fromEntries(dataMap.entries());
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  }, [dataMap, STORAGE_KEY]);

  const sortedDaily = useMemo<DailyPoint[]>(() => {
    return Array.from(dataMap.entries())
      .map(([d, v]) => ({ date: d, value: v }))
      .sort((a, b) => sortISO(a.date, b.date));
  }, [dataMap]);

  useEffect(() => {
    if (!sortedDaily.length) return;
    const lastIso = sortedDaily[sortedDaily.length - 1].date;
    if (!toIso) setToIso(lastIso);
    if (!fromIso) setFromIso(isoMinusDays(lastIso, clamp(rangeDays, 7, 3650)));
  }, [sortedDaily, toIso, fromIso, rangeDays]);

  const dailyLookup = useMemo(() => new Map(sortedDaily.map((d) => [d.date, d.value] as const)), [sortedDaily]);

  const monthAggMap = useMemo(() => buildMonthAggMap(sortedDaily), [sortedDaily]);

  const supportsRollingSum = calcMode === "sum";

  const dailyForChart = useMemo<DailyChartPoint[]>(() => {
    if (!sortedDaily.length) return [];

    const lastIso = sortedDaily[sortedDaily.length - 1].date;
    const effectiveTo = toIso || lastIso;
    const effectiveFrom = fromIso || isoMinusDays(lastIso, clamp(rangeDays, 7, 3650));

    const f = effectiveFrom <= effectiveTo ? effectiveFrom : effectiveTo;
    const t = effectiveFrom <= effectiveTo ? effectiveTo : effectiveFrom;

    const filtered = sortedDaily.filter((d) => d.date >= f && d.date <= t);

    const sumCountRangeInclusive = (startIso: string, endIso: string) => {
      if (startIso > endIso) return { sum: null as number | null, count: 0 };
      let sum = 0;
      let count = 0;
      let cur = startIso;
      while (cur <= endIso) {
        const v = dailyLookup.get(cur);
        if (v != null) {
          sum += v;
          count += 1;
        }
        cur = isoPlusDays(cur, 1);
      }
      return { sum: count ? sum : null, count };
    };

    const isRollingAvg45 = aggFreq === "rolling45_avg";
    const isRollingAvg30 = aggFreq === "rolling30_avg";
    const isRollingAvg14 = aggFreq === "rolling14_avg";
    const isRollingSum30 = aggFreq === "rolling30_sum";
    const isWeeklyRollingAvg7 = aggFreq === "weekly_roll7_avg";

    if (aggFreq === "daily") {
      const sameDayPrevYear = (iso: string) => `${Number(iso.slice(0, 4)) - 1}${iso.slice(4)}`;
      const sameDayPrevMonth = (iso: string) => {
        const y = Number(iso.slice(0, 4));
        const m = Number(iso.slice(5, 7));
        const d = Number(iso.slice(8, 10));
        const dt = new Date(Date.UTC(y, m - 2, d));
        const iso2 = dt.toISOString().slice(0, 10);
        return Number(iso2.slice(8, 10)) === d ? iso2 : null;
      };

      return filtered.map((d) => {
        const pyDate = sameDayPrevYear(d.date);
        const pmDate = sameDayPrevMonth(d.date);
        const py = dailyLookup.get(pyDate) ?? null;
        const pm = pmDate ? dailyLookup.get(pmDate) ?? null : null;

        return {
          label: formatDDMMYYYY(d.date),
          units: d.value,
          prev_year_units: py,
          yoy_pct: py != null ? growthPct(d.value, py) : null,
          mom_pct: pm != null ? growthPct(d.value, pm) : null,
        };
      });
    }

    // ✅ NEW: 45-day rolling avg (simple moving average of last 45 daily points)
    // YoY compares against the same 45-day window last year (shift by 365 days, consistent with existing rolling logic)
    if (isRollingAvg45) {
      const points: DailyChartPoint[] = [];
      let cur = f;
      while (cur <= t) {
        const start = isoMinusDays(cur, 44); // last 45 days inclusive
        const currSC = sumCountRangeInclusive(start, cur);
        const currVal = currSC.sum != null && currSC.count ? currSC.sum / currSC.count : 0;

        const curPrevYear = isoMinusDays(cur, 365);
        const startPrevYear = isoMinusDays(curPrevYear, 44);
        const prevSC = sumCountRangeInclusive(startPrevYear, curPrevYear);
        const prevVal = prevSC.sum != null && prevSC.count ? prevSC.sum / prevSC.count : null;

        points.push({
          label: formatDDMMYYYY(cur),
          units: currVal,
          prev_year_units: prevVal,
          yoy_pct: prevVal != null ? growthPct(currVal, prevVal) : null,
          mom_pct: null,
        });

        cur = isoPlusDays(cur, 1);
      }
      return points;
    }

    // 30-day rolling avg/sum (existing)
    if (isRollingAvg30 || isRollingSum30) {
      const points: DailyChartPoint[] = [];
      let cur = f;
      while (cur <= t) {
        const start = isoMinusDays(cur, 29);
        const currSC = sumCountRangeInclusive(start, cur);

        const currVal =
          isRollingSum30 ? (currSC.sum ?? 0) : currSC.sum != null && currSC.count ? currSC.sum / currSC.count : 0;

        const curPrevYear = isoMinusDays(cur, 365);
        const startPrevYear = isoMinusDays(curPrevYear, 29);
        const prevSC = sumCountRangeInclusive(startPrevYear, curPrevYear);

        const prevVal =
          isRollingSum30
            ? prevSC.sum
            : prevSC.sum != null && prevSC.count
              ? prevSC.sum / prevSC.count
              : null;

        points.push({
          label: formatDDMMYYYY(cur),
          units: currVal,
          prev_year_units: prevVal,
          yoy_pct: prevVal != null ? growthPct(currVal, prevVal) : null,
          mom_pct: null,
        });

        cur = isoPlusDays(cur, 1);
      }
      return points;
    }

    // ✅ Fortnightly Rolling (AVG) (last 14 days)
    if (isRollingAvg14) {
      const points: DailyChartPoint[] = [];
      let cur = f;
      while (cur <= t) {
        const start = isoMinusDays(cur, 13); // last 14 days inclusive
        const currSC = sumCountRangeInclusive(start, cur);
        const currVal = currSC.sum != null && currSC.count ? currSC.sum / currSC.count : 0;

        // YoY compare vs same 14-day window last year (calendar shift by 365 days, consistent with existing rolling)
        const curPrevYear = isoMinusDays(cur, 365);
        const startPrevYear = isoMinusDays(curPrevYear, 13);
        const prevSC = sumCountRangeInclusive(startPrevYear, curPrevYear);
        const prevVal = prevSC.sum != null && prevSC.count ? prevSC.sum / prevSC.count : null;

        points.push({
          label: formatDDMMYYYY(cur),
          units: currVal,
          prev_year_units: prevVal,
          yoy_pct: prevVal != null ? growthPct(currVal, prevVal) : null,
          mom_pct: null,
        });

        cur = isoPlusDays(cur, 1);
      }
      return points;
    }

    // ✅ Weekly Rolling (AVG) (last 7 days)
    if (isWeeklyRollingAvg7) {
      const points: DailyChartPoint[] = [];
      let cur = f;

      while (cur <= t) {
        const start = isoMinusDays(cur, 6); // last 7 days inclusive
        const currSC = sumCountRangeInclusive(start, cur);
        const currVal = currSC.sum != null && currSC.count ? currSC.sum / currSC.count : 0;

        // YoY compare vs same 7-day window last year (calendar shift by 365 days, consistent with existing rolling)
        const curPrevYear = isoMinusDays(cur, 365);
        const startPrevYear = isoMinusDays(curPrevYear, 6);
        const prevSC = sumCountRangeInclusive(startPrevYear, curPrevYear);
        const prevVal = prevSC.sum != null && prevSC.count ? prevSC.sum / prevSC.count : null;

        // WoW%: compare to previous 7-day window ending 7 days earlier
        const curPrevWeekEnd = isoMinusDays(cur, 7);
        const curPrevWeekStart = isoMinusDays(curPrevWeekEnd, 6);
        const prevWSC = sumCountRangeInclusive(curPrevWeekStart, curPrevWeekEnd);
        const prevWVal = prevWSC.sum != null && prevWSC.count ? prevWSC.sum / prevWSC.count : null;

        points.push({
          label: formatDDMMYYYY(cur),
          units: currVal,
          prev_year_units: prevVal,
          yoy_pct: prevVal != null ? growthPct(currVal, prevVal) : null,
          mom_pct: prevWVal != null ? growthPct(currVal, prevWVal) : null, // WoW%
        });

        cur = isoPlusDays(cur, 1);
      }

      return points;
    }

    // monthly (unchanged)
    const startYM = monthKey(f);
    const endYM = monthKey(t);

    const months: string[] = [];
    let cursor = startYM;
    while (cursor <= endYM) {
      if (monthAggMap.has(cursor)) months.push(cursor);
      cursor = addMonths(cursor, 1);
      if (months.length > 600) break;
    }

    return months.map((m) => {
      const rec = monthAggMap.get(m)!;
      const curr = calcMode === "sum" ? rec.sum : rec.sum / rec.count;

      const prevMonth = addMonths(m, -1);
      const prevRec = monthAggMap.get(prevMonth);
      const prevVal = prevRec ? (calcMode === "sum" ? prevRec.sum : prevRec.sum / prevRec.count) : null;

      const prevYearMonth = `${getYear(m) - 1}-${String(getMonth(m)).padStart(2, "0")}`;
      const pyRec = monthAggMap.get(prevYearMonth);
      const pyVal = pyRec ? (calcMode === "sum" ? pyRec.sum : pyRec.sum / pyRec.count) : null;

      return {
        label: m,
        units: curr,
        prev_year_units: pyVal,
        yoy_pct: pyVal != null ? growthPct(curr, pyVal) : null,
        mom_pct: prevVal != null ? growthPct(curr, prevVal) : null,
      };
    });
  }, [sortedDaily, dailyLookup, fromIso, toIso, rangeDays, aggFreq, calcMode, monthAggMap]);

  const controlStatsLeft = useMemo(() => {
    if (!showControlLines) return null;
    if (!dailyForChart.length) return null;

    const values: number[] = [];
    if (showUnitsSeries) for (const p of dailyForChart) values.push(p.units);
    else if (showPrevYearSeries)
      for (const p of dailyForChart) if (p.prev_year_units != null) values.push(p.prev_year_units);
    else return null;

    if (values.length < 2) return null;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
    const sd = Math.sqrt(variance);
    return { mean, sd, p1: mean + sd, p2: mean + 2 * sd, m1: mean - sd, m2: mean - 2 * sd };
  }, [showControlLines, dailyForChart, showUnitsSeries, showPrevYearSeries]);

  const controlStatsYoY = useMemo(() => {
    if (!showControlLines) return null;
    if (!dailyForChart.length) return null;
    if (!showYoYSeries) return null;

    const values: number[] = [];
    for (const p of dailyForChart) if (p.yoy_pct != null) values.push(p.yoy_pct);
    if (values.length < 2) return null;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
    const sd = Math.sqrt(variance);
    return { mean, sd, p1: mean + sd, p2: mean + 2 * sd, m1: mean - sd, m2: mean - 2 * sd };
  }, [showControlLines, dailyForChart, showYoYSeries]);

  const dailyForChartWithControl = useMemo(() => {
    const base = dailyForChart.map((p) => ({
      ...p,
      __mean_units: controlStatsLeft ? controlStatsLeft.mean : null,
      __p1_units: controlStatsLeft ? controlStatsLeft.p1 : null,
      __p2_units: controlStatsLeft ? controlStatsLeft.p2 : null,
      __m1_units: controlStatsLeft ? controlStatsLeft.m1 : null,
      __m2_units: controlStatsLeft ? controlStatsLeft.m2 : null,

      __mean_yoy: controlStatsYoY ? controlStatsYoY.mean : null,
      __p1_yoy: controlStatsYoY ? controlStatsYoY.p1 : null,
      __p2_yoy: controlStatsYoY ? controlStatsYoY.p2 : null,
      __m1_yoy: controlStatsYoY ? controlStatsYoY.m1 : null,
      __m2_yoy: controlStatsYoY ? controlStatsYoY.m2 : null,
    }));
    return base as any[];
  }, [dailyForChart, controlStatsLeft, controlStatsYoY]);

  const anyTotalsShown = showUnitsSeries || showPrevYearSeries || (showControlLines && !!controlStatsLeft);
  const anyPctShown = showYoYSeries || showMoMSeries || (showControlLines && !!controlStatsYoY);

  const leftAxisDomain = useMemo(() => {
    if (!dailyForChartWithControl.length) return undefined;
    const vals: Array<number | null> = [];
    if (showUnitsSeries) vals.push(...dailyForChartWithControl.map((d) => d.units));
    if (showPrevYearSeries) vals.push(...dailyForChartWithControl.map((d) => d.prev_year_units));
    if (showControlLines) {
      vals.push(...dailyForChartWithControl.map((d) => d.__mean_units));
      vals.push(...dailyForChartWithControl.map((d) => d.__p1_units));
      vals.push(...dailyForChartWithControl.map((d) => d.__p2_units));
      vals.push(...dailyForChartWithControl.map((d) => d.__m1_units));
      vals.push(...dailyForChartWithControl.map((d) => d.__m2_units));
    }
    return computeDomain(vals, 0.05, 0.5);
  }, [dailyForChartWithControl, showUnitsSeries, showPrevYearSeries, showControlLines]);

  const rightAxisDomain = useMemo(() => {
    if (!dailyForChartWithControl.length) return undefined;
    const vals: Array<number | null> = [];
    if (showYoYSeries) vals.push(...dailyForChartWithControl.map((d) => d.yoy_pct));
    if (showMoMSeries) vals.push(...dailyForChartWithControl.map((d) => d.mom_pct));
    if (showControlLines) {
      vals.push(...dailyForChartWithControl.map((d) => d.__mean_yoy));
      vals.push(...dailyForChartWithControl.map((d) => d.__p1_yoy));
      vals.push(...dailyForChartWithControl.map((d) => d.__p2_yoy));
      vals.push(...dailyForChartWithControl.map((d) => d.__m1_yoy));
      vals.push(...dailyForChartWithControl.map((d) => d.__m2_yoy));
    }
    return computeDomain(vals, 0.05, 1);
  }, [dailyForChartWithControl, showYoYSeries, showMoMSeries, showControlLines]);

  const monthlyAgg = useMemo(() => {
    return calcMode === "sum" ? toMonthlySumComparable(sortedDaily) : toMonthlyAvgFull(sortedDaily);
  }, [sortedDaily, calcMode]);

  const monthlyForChart = useMemo(() => {
    if (!monthlyAgg.length) return [];
    const last = monthlyAgg.slice(Math.max(0, monthlyAgg.length - 24));
    return last.map((m) => ({
      month: m.month,
      value: m.value,
      yoy_pct: m.yoy_pct,
      mom_pct: m.mom_pct,
    }));
  }, [monthlyAgg]);

  // ✅ Peak Demand Met requirement: average of 24 monthly values (only for this tab)
  const monthlyFooterAvgForPeakDemand = useMemo(() => {
    if (type !== "demand") return null;
    if (calcMode !== "avg") return null;
    const vals = monthlyForChart.map((d) => asFiniteNumber(d.value)).filter((v): v is number => v != null);
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }, [type, calcMode, monthlyForChart]);

  const monthlyChartMean = useMemo(() => {
    if (!monthlyForChart.length) return null;
    const vals = monthlyForChart.map((d) => asFiniteNumber(d.value)).filter((v): v is number => v != null);
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }, [monthlyForChart]);

  const kpis = useMemo(() => computeKPIs(sortedDaily, calcMode), [sortedDaily, calcMode]);

  const weeklyRows = useMemo(() => {
    if (!sortedDaily.length) return [];

    const weekSum = new Map<string, number>();
    const weekCount = new Map<string, number>();

    for (const d of sortedDaily) {
      const wk = startOfWeekISO(d.date);
      weekSum.set(wk, (weekSum.get(wk) || 0) + d.value);
      weekCount.set(wk, (weekCount.get(wk) || 0) + 1);
    }

    const weeks = Array.from(weekSum.keys()).sort(sortISO);
    const lastWeeks = weeks.slice(Math.max(0, weeks.length - 104));

    return lastWeeks.map((wk) => {
      const sum = weekSum.get(wk)!;
      const cnt = weekCount.get(wk)!;
      const curr = calcMode === "sum" ? sum : sum / cnt;

      const prevWk = isoMinusDays(wk, 7);
      const prevSum = weekSum.get(prevWk);
      const prevCnt = weekCount.get(prevWk);
      const prevVal = prevSum != null && prevCnt ? (calcMode === "sum" ? prevSum : prevSum / prevCnt) : null;

      const prevYearWk = isoMinusDays(wk, 364);
      const pySum = weekSum.get(prevYearWk);
      const pyCnt = weekCount.get(prevYearWk);
      const pyVal = pySum != null && pyCnt ? (calcMode === "sum" ? pySum : pySum / pyCnt) : null;

      return {
        weekStart: wk,
        value: curr,
        wow_pct: prevVal != null ? growthPct(curr, prevVal) : null,
        yoy_pct: pyVal != null ? growthPct(curr, pyVal) : null,
      };
    });
  }, [sortedDaily, calcMode]);

  const yearlyFYRows = useMemo(() => {
    if (!sortedDaily.length) return [];

    const fySum = new Map<string, number>();
    const fyCount = new Map<string, number>();
    const fyMaxDate = new Map<string, string>();

    const fyLabelFromIso = (iso: string) => {
      const y = Number(iso.slice(0, 4));
      const m = Number(iso.slice(5, 7));
      const fyEndYear = m >= 4 ? y + 1 : y;
      return `FY${String(fyEndYear).slice(2)}`;
    };

    for (const d of sortedDaily) {
      const fy = fyLabelFromIso(d.date);
      fySum.set(fy, (fySum.get(fy) || 0) + d.value);
      fyCount.set(fy, (fyCount.get(fy) || 0) + 1);
      const curMax = fyMaxDate.get(fy) || "0000-00-00";
      if (d.date > curMax) fyMaxDate.set(fy, d.date);
    }

    const fys = Array.from(fySum.keys()).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));

    const isoAddYears = (iso: string, deltaYears: number) => {
      const y = Number(iso.slice(0, 4));
      const m = Number(iso.slice(5, 7));
      const d = Number(iso.slice(8, 10));
      const tryDt = new Date(Date.UTC(y + deltaYears, m - 1, d));
      if (
        tryDt.getUTCFullYear() === y + deltaYears &&
        tryDt.getUTCMonth() === m - 1 &&
        tryDt.getUTCDate() === d
      )
        return tryDt.toISOString().slice(0, 10);
      const lastDay = new Date(Date.UTC(y + deltaYears, m, 0));
      return lastDay.toISOString().slice(0, 10);
    };

    const fyStartIsoFromFYLabel = (fy: string) => {
      const yy = Number(fy.slice(2));
      const fyEndYear = 2000 + yy;
      const fyStartYear = fyEndYear - 1;
      return `${fyStartYear}-04-01`;
    };

    const sumCountInclusive = (startIso: string, endIso: string, dailyLookup: Map<string, number>) => {
      if (startIso > endIso) return { sum: null as number | null, count: 0 };
      let sum = 0;
      let count = 0;
      let cur = startIso;
      while (cur <= endIso) {
        const v = dailyLookup.get(cur);
        if (v != null) {
          sum += v;
          count += 1;
        }
        cur = isoPlusDays(cur, 1);
      }
      return { sum: count ? sum : null, count };
    };

    return fys.map((fy) => {
      const sum = fySum.get(fy)!;
      const cnt = fyCount.get(fy)!;
      const curr = calcMode === "sum" ? sum : sum / cnt;

      const prevFY = `FY${String(Number(fy.slice(2)) - 1).padStart(2, "0")}`;
      const prevSum = fySum.get(prevFY);
      const prevCnt = fyCount.get(prevFY);
      const prev = prevSum != null && prevCnt ? (calcMode === "sum" ? prevSum : prevSum / prevCnt) : null;

      const fyEndYear = 2000 + Number(fy.slice(2));
      const fyEnd = `${fyEndYear}-03-31`;
      const maxDate = fyMaxDate.get(fy)!;
      const isComplete = maxDate >= fyEnd;

      let yoy: number | null = null;

      if (prevSum != null && prevCnt) {
        if (isComplete) {
          yoy = prev != null ? growthPct(curr, prev) : null;
        } else {
          const start = fyStartIsoFromFYLabel(fy);
          const prevStart = fyStartIsoFromFYLabel(prevFY);
          const prevEnd = isoAddYears(maxDate, -1);

          const currSC = sumCountInclusive(start, maxDate, dailyLookup);
          const prevSC = sumCountInclusive(prevStart, prevEnd, dailyLookup);

          const currVal =
            calcMode === "sum"
              ? currSC.sum
              : currSC.sum != null && currSC.count
                ? currSC.sum / currSC.count
                : null;

          const prevVal =
            calcMode === "sum"
              ? prevSC.sum
              : prevSC.sum != null && prevSC.count
                ? prevSC.sum / prevSC.count
                : null;

          yoy = currVal != null && prevVal != null ? growthPct(currVal, prevVal) : null;
        }
      }

      return { fy, value: curr, yoy_pct: yoy };
    });
  }, [sortedDaily, calcMode, dailyLookup]);

  const hasData = sortedDaily.length > 0;

  function upsertOne() {
    setMsg(null);
    setErrors([]);

    const iso = parseInputDate(date);
    if (!iso) {
      setErrors(["Please enter a valid date (DD-MM-YYYY or DD/MM/YYYY)."]);
      return;
    }

    const v = Number(String(valueText).replace(/,/g, ""));
    if (!Number.isFinite(v)) {
      setErrors([`Please enter a valid number.`]);
      return;
    }

    setDataMap((prev) => {
      const next = new Map(prev);
      next.set(iso, v);
      return next;
    });

    setMsg(`Saved ${formatDDMMYYYY(iso)}: ${fmtValue(v)}`);
    setValueText("");
  }

  function removeDate(isoDate: string) {
    setDataMap((prev) => {
      const next = new Map(prev);
      next.delete(isoDate);
      return next;
    });
  }

  function clearAll() {
    if (!confirm(`Clear all stored data from this browser for ${seriesLabel}?`)) return;
    setDataMap(new Map());
    setMsg("Cleared all data.");
  }

  async function importCSV(file?: File) {
    setMsg(null);
    setErrors([]);
    if (!file) return;

    try {
      const text = await file.text();
      const { parsed, errors: errs } = csvParse(text, valueColumnKey);
      if (errs.length) setErrors(errs.slice(0, 12));
      if (!parsed.length) {
        setErrors((e) => (e.length ? e : ["No valid rows found in CSV."]));
        return;
      }
      setDataMap((prev) => mergeRecords(prev, parsed));
      setMsg(`Imported ${parsed.length} rows${errs.length ? ` (with ${errs.length} issues)` : ""}.`);
    } catch {
      setErrors(["Could not read CSV."]);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function exportCSV() {
    const header = `date,${valueColumnKey}`;
    // ✅ export uses dd/mm/yyyy
    const lines = sortedDaily.map((d) => `${formatDDMMYYYYForCSV(d.date)},${d.value}`);
    downloadCSV(`india_${type}_${new Date().toISOString().slice(0, 10)}.csv`, [header, ...lines].join("\n"));
  }

  function loadSample() {
    const { parsed } = csvParse(sampleCSV(valueColumnKey), valueColumnKey);
    setDataMap((prev) => mergeRecords(prev, parsed));
    setMsg("Loaded sample data.");
  }

  async function fetchLatestFromCEA() {
    setFetchStatus("Auto-fetch not enabled for this tab.");
  }

  const periodValueLabel = calcMode === "avg" ? "Avg" : "Total";
  const ytdLabel = calcMode === "avg" ? "YTD Avg (from 1 Apr)" : "YTD Total (from 1 Apr)";

  const rolling45AvgLabel = "Last 45 Days Rolling Avg (YoY Growth)";
  const rollingAvgLabel = "Last 30 Days Rolling Avg (YoY Growth)";
  const rollingSumLabel = "Last 30 Days Rolling Sum (YoY Growth)";
  const fortnightRollingAvgLabel = "Fortnightly Rolling (AVG) (last 14 days)";
  const weeklyRollingAvgLabel = "Weekly Rolling (AVG) (last 7 days)";

  const isWeeklyRollingAvg7 = aggFreq === "weekly_roll7_avg";

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-8">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-2xl font-semibold text-slate-900">{title}</div>
            <div className="mt-1 text-sm text-slate-600">{subtitle}</div>
          </div>

          {extraBadgeCols !== undefined ? (
            <div className="flex flex-wrap items-center gap-2">
              {!hideMainBadge && kpis.latest && (
                <div className="rounded-xl bg-white px-4 py-2 ring-1 ring-slate-200 text-center">
                  <div className="text-lg font-bold text-slate-900">{fmtValue(kpis.latest.value)}</div>
                  <div className="text-xs text-slate-500">Avg · {unitLabel}</div>
                </div>
              )}
              {extraBadgeCols.map(({ key, label, isText }) => {
                const numericMap = extraBadgeCsvPath ? extraBadgeLatestValues : extraLatestValues;
                const textMap = extraBadgeCsvPath ? extraBadgeTextValues : extraTextValues;
                const display = isText
                  ? (textMap.get(key) ?? "—")
                  : numericMap.get(key) != null
                    ? fmtValue(numericMap.get(key)!)
                    : "—";
                return (
                  <div key={key} className="rounded-xl bg-white px-4 py-2 ring-1 ring-slate-200 text-center">
                    <div className="text-lg font-bold text-slate-900">{display}</div>
                    <div className="text-xs text-slate-500">{label}</div>
                  </div>
                );
              })}
              {kpis.latest && (
                <div className="text-xs text-slate-400 self-end pb-1">
                  {formatDDMMYYYY(kpis.latest.date)}
                </div>
              )}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => downloadCSV(`sample_${type}.csv`, sampleCSV(valueColumnKey))}
              className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
            >
              Download sample CSV
            </button>

            {enableAutoFetch ? (
              <button
                onClick={fetchLatestFromCEA}
                className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              >
                Auto-fetch latest (incl. RE)
              </button>
            ) : null}

            <button
              onClick={exportCSV}
              disabled={!hasData}
              className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-50"
            >
              Export CSV
            </button>

            <button
              onClick={clearAll}
              disabled={!hasData}
              className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-rose-700 ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-50"
            >
              Clear data
            </button>
          </div>
        </div>

        {/* Daily card */}
        <div className="mt-6 grid grid-cols-1 gap-4">
          <Card
            title={`Daily ${seriesLabel.toLowerCase()}`}
            right={
              hasData ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">Range</span>
                  <select
                    value={rangeDays}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setRangeDays(v);
                      if (sortedDaily.length) {
                        const lastIso = sortedDaily[sortedDaily.length - 1].date;
                        setToIso(lastIso);
                        setFromIso(isoMinusDays(lastIso, clamp(v, 7, 3650)));
                      }
                    }}
                    className="rounded-xl border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700"
                  >
                    <option value={60}>Last 60 days</option>
                    <option value={120}>Last 120 days</option>
                    <option value={365}>Last 12 months</option>
                    <option value={730}>Last 24 months</option>
                    <option value={1825}>Last 5 years</option>
                    <option value={3650}>Last 10 years</option>
                  </select>
                </div>
              ) : null
            }
          >
            {!hasData ? (
              <div className="text-sm text-slate-600">Add data to see the daily chart.</div>
            ) : (
              <>
                {/* Controls */}
                <div className="mb-3 rounded-2xl bg-slate-50 p-2 ring-1 ring-slate-200">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
                    <div className="flex-1">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                          <div className="text-xs font-medium text-slate-600">From</div>
                          <input
                            type="date"
                            value={fromIso}
                            onChange={(e) => setFromIso(e.target.value)}
                            className="mt-1 w-full min-w-[180px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-slate-300 tabular-nums"
                          />

                          <div className="mt-1 text-[12px] font-medium text-slate-600 tabular-nums">
                            {fromIso ? formatDDMMYY(fromIso) : ""}
                          </div>
                        </div>

                        <div>
                          <div className="text-xs font-medium text-slate-600">To</div>
                          <input
                            type="date"
                            value={toIso}
                            onChange={(e) => setToIso(e.target.value)}
                            className="mt-1 w-full min-w-[180px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-slate-300 tabular-nums"
                          />
                          <div className="mt-1 text-[12px] font-medium text-slate-600 tabular-nums">
                            {toIso ? formatDDMMYY(toIso) : ""}
                          </div>
                        </div>
                      </div>

                      <div className="mt-3">
                        <div className="text-xs font-medium text-slate-600">View as</div>
                        <select
                          value={aggFreq}
                          onChange={(e) => setAggFreq(e.target.value as ViewAs)}
                          className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                        >
                          <option value="rolling45_avg">{rolling45AvgLabel}</option>
                          <option value="rolling30_avg">{rollingAvgLabel}</option>
                          <option value="rolling14_avg">{fortnightRollingAvgLabel}</option>
                          <option value="daily">Daily</option>

                          {/* ✅ Weekly Rolling (AVG) (last 7 days) */}
                          <option value="weekly_roll7_avg">{weeklyRollingAvgLabel}</option>

                          <option value="monthly">{calcMode === "avg" ? "Monthly (Avg)" : "Monthly (Sum)"}</option>
                          {supportsRollingSum ? <option value="rolling30_sum">{rollingSumLabel}</option> : null}
                        </select>
                      </div>
                    </div>

                    <div className="lg:w-[360px] lg:shrink-0">
                      <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs font-semibold text-slate-700">Series toggles</div>
                          <label className="flex items-center gap-2 text-[12px] text-slate-700">
                            <input
                              type="checkbox"
                              checked={showControlLines}
                              onChange={(e) => setShowControlLines(e.target.checked)}
                              className="h-4 w-4 rounded border-slate-300"
                            />
                            <span className="font-medium">Show Control Lines</span>
                          </label>
                        </div>

                        <div className="mt-2 grid grid-cols-2 gap-2 text-[12px] text-slate-700">
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={showUnitsSeries}
                              onChange={(e) => setShowUnitsSeries(e.target.checked)}
                              className="h-4 w-4 rounded border-slate-300"
                            />
                            <span className="font-medium">
                              {calcMode === "avg" && aggFreq !== "daily" ? `${periodValueLabel} Current` : "Total Current"}
                            </span>
                          </label>

                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={showPrevYearSeries}
                              onChange={(e) => setShowPrevYearSeries(e.target.checked)}
                              className="h-4 w-4 rounded border-slate-300"
                            />
                            <span className="font-medium">
                              {calcMode === "avg" && aggFreq !== "daily"
                                ? `${periodValueLabel} (previous year)`
                                : "Total (previous year)"}
                            </span>
                          </label>

                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={showYoYSeries}
                              onChange={(e) => setShowYoYSeries(e.target.checked)}
                              className="h-4 w-4 rounded border-slate-300"
                            />
                            <span className="font-medium">YoY %</span>
                          </label>

                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={showMoMSeries}
                              onChange={(e) => setShowMoMSeries(e.target.checked)}
                              className="h-4 w-4 rounded border-slate-300"
                            />
                            <span className="font-medium">{isWeeklyRollingAvg7 ? "WoW %" : "MoM %"}</span>
                          </label>
                        </div>

                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setShowUnitsSeries(false);
                              setShowPrevYearSeries(false);
                              setShowMoMSeries(false);
                              setShowYoYSeries(true);
                            }}
                            className="rounded-lg bg-slate-900 px-2 py-1 text-[12px] font-semibold text-white hover:bg-slate-800"
                          >
                            YoY% only
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setShowUnitsSeries(true);
                              setShowPrevYearSeries(true);
                              setShowMoMSeries(false);
                              setShowYoYSeries(false);
                            }}
                            className="rounded-lg bg-white px-2 py-1 text-[12px] font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
                          >
                            Totals only
                          </button>
                        </div>
                      </div>

                      <div className="mt-2 text-[11px] text-slate-500">
                        {aggFreq === "rolling45_avg"
                          ? "Last 45 Days Rolling (AVG) uses a 45-day window and compares against the same 45-day window last year."
                          : aggFreq === "rolling30_avg" || aggFreq === "rolling30_sum"
                            ? "Rolling Avg/Sum uses a 30-day window and compares against the same 30-day window last year."
                            : aggFreq === "rolling14_avg"
                              ? "Fortnightly Rolling (AVG) uses a 14-day window and compares against the same 14-day window last year."
                              : aggFreq === "weekly_roll7_avg"
                                ? "Weekly Rolling (AVG) uses a 7-day window and compares against the same 7-day window last year."
                                : null}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="h-[380px] sm:h-[460px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={dailyForChartWithControl} margin={{ top: 12, right: 42, bottom: 12, left: 42 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="label" tick={{ fontSize: 12 }} minTickGap={24} />

                      {anyTotalsShown ? (
                        <YAxis
                          yAxisId="left"
                          width={92}
                          tickMargin={10}
                          domain={leftAxisDomain ?? ["auto", "auto"]}
                          padding={{ top: 10, bottom: 10 }}
                          tick={{ fontSize: 12 }}
                          tickFormatter={(v) => {
                            const n = asFiniteNumber(v);
                            if (n == null) return "—";
                            return new Intl.NumberFormat("en-IN", {
                              minimumFractionDigits: valueDisplay.decimals,
                              maximumFractionDigits: valueDisplay.decimals,
                            }).format(Number(n.toFixed(valueDisplay.decimals)));
                          }}
                        />
                      ) : null}

                      {anyPctShown ? (
                        <YAxis
                          yAxisId="right"
                          orientation="right"
                          width={84}
                          tickMargin={10}
                          domain={rightAxisDomain ?? ["auto", "auto"]}
                          padding={{ top: 10, bottom: 10 }}
                          tick={{ fontSize: 12 }}
                          tickFormatter={(v) => {
                            const n = asFiniteNumber(v);
                            return n == null ? "—" : `${Number(n.toFixed(2)).toFixed(2)}%`;
                          }}
                        />
                      ) : null}

                      <Tooltip
                        wrapperStyle={{ outline: "none" }}
                        formatter={(v: any, name: any, item: any) => {
                          const key = (item && (item.dataKey as string)) || (name as string);
                          const num = asFiniteNumber(v);

                          const labelCurr =
                            calcMode === "avg" && aggFreq !== "daily" ? `${periodValueLabel} Current` : "Total Current";
                          const labelPY =
                            calcMode === "avg" && aggFreq !== "daily"
                              ? `${periodValueLabel} (previous year)`
                              : "Total (previous year)";

                          if (key === "units") return [fmtValue(num ?? null), labelCurr];
                          if (key === "prev_year_units") return [fmtValue(num ?? null), labelPY];
                          if (key === "yoy_pct") return [fmtPct(num ?? null), "YoY %"];
                          if (key === "mom_pct") return [fmtPct(num ?? null), isWeeklyRollingAvg7 ? "WoW %" : "MoM %"];

                          if (key === "__mean_units") return [fmtValue(num ?? null), "Mean"];
                          if (key === "__p1_units") return [fmtValue(num ?? null), "+1σ"];
                          if (key === "__p2_units") return [fmtValue(num ?? null), "+2σ"];
                          if (key === "__m1_units") return [fmtValue(num ?? null), "-1σ"];
                          if (key === "__m2_units") return [fmtValue(num ?? null), "-2σ"];

                          if (key === "__mean_yoy") return [fmtPct(num ?? null), "Mean (YoY%)"];
                          if (key === "__p1_yoy") return [fmtPct(num ?? null), "+1σ (YoY%)"];
                          if (key === "__p2_yoy") return [fmtPct(num ?? null), "+2σ (YoY%)"];
                          if (key === "__m1_yoy") return [fmtPct(num ?? null), "-1σ (YoY%)"];
                          if (key === "__m2_yoy") return [fmtPct(num ?? null), "-2σ (YoY%)"];

                          return [v, String(name)];
                        }}
                        labelFormatter={(l: any) => {
                          const timeEntry = textByDate.get(l as string);
                          if (!timeEntry || timeEntry.size === 0) return `Label: ${l}`;
                          return (
                            <span>
                              {`Label: ${l}`}
                              {Array.from(timeEntry.entries()).map(([key, val]) => {
                                const col = extraBadgeCols?.find((c) => c.key === key);
                                return (
                                  <span key={key}>
                                    <br />
                                    {col?.label ?? key}: {val}
                                  </span>
                                );
                              })}
                            </span>
                          );
                        }}
                      />
                      <Legend />

                      {showUnitsSeries ? (
                        <Line
                          yAxisId="left"
                          type="monotone"
                          dataKey="units"
                          name="Current"
                          dot={false}
                          strokeWidth={2}
                          stroke="#dc2626"
                        />
                      ) : null}

                      {showPrevYearSeries ? (
                        <Line
                          yAxisId="left"
                          type="monotone"
                          dataKey="prev_year_units"
                          name="Previous year"
                          dot={false}
                          strokeWidth={2}
                          stroke="#6b7280"
                          connectNulls
                        />
                      ) : null}

                      {showYoYSeries ? (
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="yoy_pct"
                          name="YoY %"
                          dot={false}
                          strokeWidth={2}
                          stroke="#16a34a"
                          connectNulls
                        />
                      ) : null}

                      {showMoMSeries ? (
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="mom_pct"
                          name={isWeeklyRollingAvg7 ? "WoW %" : "MoM %"}
                          dot={false}
                          strokeWidth={2}
                          stroke="#dc2626"
                          connectNulls
                        />
                      ) : null}

                      {showControlLines && controlStatsLeft ? (
                        <>
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="__mean_units"
                            name="Mean"
                            dot={false}
                            strokeWidth={2}
                            stroke="#000000"
                            connectNulls
                          />
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="__p1_units"
                            name="+1σ"
                            dot={false}
                            strokeWidth={2}
                            stroke="#2563eb"
                            strokeDasharray="6 4"
                            connectNulls
                          />
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="__p2_units"
                            name="+2σ"
                            dot={false}
                            strokeWidth={2}
                            stroke="#4f46e5"
                            strokeDasharray="6 4"
                            connectNulls
                          />
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="__m1_units"
                            name="-1σ"
                            dot={false}
                            strokeWidth={2}
                            stroke="#f97316"
                            strokeDasharray="6 4"
                            connectNulls
                          />
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="__m2_units"
                            name="-2σ"
                            dot={false}
                            strokeWidth={2}
                            stroke="#eab308"
                            strokeDasharray="6 4"
                            connectNulls
                          />
                        </>
                      ) : null}

                      {showControlLines && controlStatsYoY ? (
                        <>
                          <Line
                            yAxisId="right"
                            type="monotone"
                            dataKey="__mean_yoy"
                            name="Mean (YoY%)"
                            dot={false}
                            strokeWidth={2}
                            stroke="#000000"
                            connectNulls
                          />
                          <Line
                            yAxisId="right"
                            type="monotone"
                            dataKey="__p1_yoy"
                            name="+1σ (YoY%)"
                            dot={false}
                            strokeWidth={2}
                            stroke="#2563eb"
                            strokeDasharray="6 4"
                            connectNulls
                          />
                          <Line
                            yAxisId="right"
                            type="monotone"
                            dataKey="__p2_yoy"
                            name="+2σ (YoY%)"
                            dot={false}
                            strokeWidth={2}
                            stroke="#4f46e5"
                            strokeDasharray="6 4"
                            connectNulls
                          />
                          <Line
                            yAxisId="right"
                            type="monotone"
                            dataKey="__m1_yoy"
                            name="-1σ (YoY%)"
                            dot={false}
                            strokeWidth={2}
                            stroke="#f97316"
                            strokeDasharray="6 4"
                            connectNulls
                          />
                          <Line
                            yAxisId="right"
                            type="monotone"
                            dataKey="__m2_yoy"
                            name="-2σ (YoY%)"
                            dot={false}
                            strokeWidth={2}
                            stroke="#eab308"
                            strokeDasharray="6 4"
                            connectNulls
                          />
                        </>
                      ) : null}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}
          </Card>
        </div>

        {/* Add / Update + Quick Stats + Recent Entries below daily */}
        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card title="Add / Update a day">
            <div className="grid grid-cols-1 gap-3">
              <label className="text-xs font-medium text-slate-600">Date (DD-MM-YYYY)</label>
              <input
                type="text"
                placeholder="DD-MM-YYYY"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-slate-300"
              />

              <label className="mt-1 text-xs font-medium text-slate-600">
                {seriesLabel} ({unitLabel})
              </label>
              <input
                inputMode="decimal"
                placeholder="e.g., 10"
                value={valueText}
                onChange={(e) => setValueText(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-slate-300"
              />

              <button
                onClick={upsertOne}
                className="mt-1 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              >
                Save day
              </button>

              <div className="mt-2">
                <div className="text-xs font-medium text-slate-600">Import CSV</div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => importCSV(e.target.files?.[0])}
                    className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-xl file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-slate-800"
                  />
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  Supported: <span className="font-mono">date,VALUE</span> (DD/MM/YYYY, number)
                </div>
              </div>

              {msg ? (
                <div className="mt-2 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 ring-1 ring-emerald-200">
                  {msg}
                </div>
              ) : null}

              {fetchStatus ? (
                <div className="mt-2 rounded-xl bg-slate-900/5 p-3 text-sm text-slate-800 ring-1 ring-slate-200">
                  {fetchStatus}
                </div>
              ) : null}

              {errors.length ? (
                <div className="mt-2 rounded-xl bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-200">
                  <div className="font-semibold">Import / input issues</div>
                  <ul className="mt-1 list-disc pl-5">
                    {errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </Card>

          <Card title="Quick stats" right={hasData ? `Records: ${sortedDaily.length}` : null}>
            {!hasData ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center">
                <div className="text-lg font-semibold text-slate-900">No data yet</div>
                <div className="mt-2 text-sm text-slate-600">Add datapoints or import a CSV.</div>
                <div className="mt-5 flex justify-center">
                  <button
                    onClick={loadSample}
                    className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                  >
                    Load sample data
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Stat
                  label="Latest day"
                  value={kpis.latest ? formatDDMMYYYY(kpis.latest.date) : "—"}
                  sub={
                    kpis.latest ? (
                      <div className="text-sm font-medium text-slate-600">{fmtValue(kpis.latest.value)}</div>
                    ) : null
                  }
                />

                <Stat
                  label="Latest YoY (same day)"
                  value={fmtPct(kpis.latestYoY)}
                  sub={<div className="text-sm text-slate-500">vs same date last year (if available)</div>}
                />

                <Stat
                  label="Current 7-Day Average"
                  value={kpis.avg7 != null ? fmtValue(kpis.avg7) : "—"}
                  sub={<YoYSub value={kpis.avg7YoY} suffix="YoY" />}
                />

                <Stat
                  label="Current 30-Day Average"
                  value={kpis.avg30 != null ? fmtValue(kpis.avg30) : "—"}
                  sub={<YoYSub value={kpis.avg30YoY} suffix="YoY" />}
                />

                <Stat
                  label={ytdLabel}
                  value={kpis.ytdValue != null ? fmtValue(kpis.ytdValue) : "—"}
                  sub={<YoYSub value={kpis.ytdYoY} suffix="YoY" />}
                />

                <Stat
                  label="MTD Average"
                  value={kpis.mtdAvg != null ? fmtValue(kpis.mtdAvg) : "—"}
                  sub={<YoYSub value={kpis.mtdYoY} suffix="YoY" />}
                />
              </div>
            )}
          </Card>

          <Card title="Recent entries">
            {!hasData ? (
              <div className="text-sm text-slate-600">Once you add data, the most recent entries will appear here.</div>
            ) : (
              <div className="max-h-[420px] overflow-auto rounded-xl ring-1 ring-slate-200">
                <table className="w-full border-collapse bg-white text-left text-sm">
                  <thead className="sticky top-0 bg-slate-50">
                    <tr>
                      <th className="px-3 py-2 text-xs font-semibold text-slate-600">Date</th>
                      <th className="px-3 py-2 text-xs font-semibold text-slate-600">
                        {seriesLabel} ({unitLabel})
                      </th>
                      <th className="px-3 py-2 text-xs font-semibold text-slate-600"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedDaily
                      .slice(-25)
                      .reverse()
                      .map((r) => (
                        <tr key={r.date} className="border-t border-slate-100">
                          <td className="px-3 py-2 font-medium text-slate-900">{formatDDMMYYYY(r.date)}</td>
                          <td className="px-3 py-2 text-slate-700">{fmtValue(r.value)}</td>
                          <td className="px-3 py-2 text-right">
                            <button
                              onClick={() => removeDate(r.date)}
                              className="rounded-lg px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        {/* Monthly totals + growth */}
        <div className="mt-6 grid grid-cols-1 gap-4">
          <Card title={`Monthly ${periodValueLabel} + growth`}>
            {!hasData ? (
              <div className="text-sm text-slate-600">Add data to see monthly metrics.</div>
            ) : (
              <div className="space-y-4">
                <div className="h-[280px] sm:h-[320px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={monthlyForChart} margin={{ top: 10, right: 18, bottom: 10, left: 12 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="month" tick={{ fontSize: 12 }} minTickGap={18} />
                      <YAxis
                        tick={{ fontSize: 12 }}
                        tickFormatter={(v) => {
                          const n = asFiniteNumber(v);
                          if (n == null) return "—";
                          return new Intl.NumberFormat("en-IN", {
                            minimumFractionDigits: valueDisplay.decimals,
                            maximumFractionDigits: valueDisplay.decimals,
                          }).format(Number(n.toFixed(valueDisplay.decimals)));
                        }}
                      />

                      {monthlyChartMean != null ? (
                        <ReferenceLine
                          y={monthlyChartMean}
                          stroke="#000000"
                          strokeDasharray="6 4"
                          ifOverflow="extendDomain"
                          isFront
                        />
                      ) : null}

                      <Tooltip
                        formatter={(v: any, n: any) => {
                          const num = asFiniteNumber(v);
                          if (n === "value") return [fmtValue(num ?? null), `Monthly ${periodValueLabel}`];
                          if (n === "yoy_pct") return [fmtPct(num ?? null), "YoY"];
                          if (n === "mom_pct") return [fmtPct(num ?? null), "MoM"];
                          if (num != null) return [fmtValue(num), String(n)];
                          return [v, String(n)];
                        }}
                      />
                      <Legend />
                      <Bar dataKey="value" name={`Monthly ${periodValueLabel} (${unitLabel})`} fill="#dc2626" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div className="h-[260px] sm:h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={monthlyForChart} margin={{ top: 10, right: 18, bottom: 10, left: 12 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="month" tick={{ fontSize: 12 }} minTickGap={18} />
                      <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `${Number(asFiniteNumber(v) ?? 0).toFixed(2)}%`} />
                      <Tooltip formatter={(v: any, n: any) => [fmtPct(asFiniteNumber(v)), String(n)]} />
                      <Legend />
                      <Line type="monotone" dataKey="yoy_pct" name="YoY %" dot={false} strokeWidth={2} stroke="#16a34a" />
                      <Line type="monotone" dataKey="mom_pct" name="MoM %" dot={false} strokeWidth={2} stroke="#dc2626" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </Card>
        </div>

        {/* Periodicity table */}
        <div className="mt-6">
          <Card
            title="Monthly table (Last 24 months)"
            right={
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">Periodicity</span>
                <select
                  value={"monthly"}
                  onChange={() => {}}
                  className="rounded-xl border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700 opacity-0 pointer-events-none"
                >
                  <option value="monthly">Monthly</option>
                </select>

                <select
                  value={tablePeriod}
                  onChange={(e) => setTablePeriod(e.target.value as any)}
                  className="rounded-xl border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700"
                >
                  <option value="monthly">Monthly</option>
                  <option value="weekly">Weekly</option>
                  <option value="yearly">Yearly (FY)</option>
                </select>
              </div>
            }
          >
            {!hasData ? (
              <div className="text-sm text-slate-600">Add data to see the table.</div>
            ) : (
              <div className="overflow-auto rounded-xl ring-1 ring-slate-200">
                {tablePeriod === "monthly" ? (
                  <table className="w-full border-collapse bg-white text-left text-sm">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">Month</th>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">
                          {periodValueLabel} ({unitLabel})
                        </th>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">MoM%</th>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">YoY%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthlyForChart
                        .slice()
                        .reverse()
                        .map((m) => (
                          <tr key={m.month} className="border-t border-slate-100">
                            <td className="px-3 py-2 font-medium text-slate-900">{m.month}</td>
                            <td className="px-3 py-2 text-slate-700">{fmtValue(m.value)}</td>

                            <td className={`px-3 py-2 ${pctColorClass(m.mom_pct)}`}>{fmtPct(m.mom_pct)}</td>
                            <td className={`px-3 py-2 ${pctColorClass(m.yoy_pct)}`}>{fmtPct(m.yoy_pct)}</td>
                          </tr>
                        ))}
                    </tbody>

                    {monthlyFooterAvgForPeakDemand != null ? (
                      <tfoot>
                        <tr className="border-t border-slate-200 bg-slate-50">
                          <td className="px-3 py-2 font-semibold text-slate-700">Avg (24M)</td>
                          <td className="px-3 py-2 font-semibold text-slate-900">{fmtValue(monthlyFooterAvgForPeakDemand)}</td>
                          <td className="px-3 py-2" />
                          <td className="px-3 py-2" />
                        </tr>
                      </tfoot>
                    ) : null}
                  </table>
                ) : tablePeriod === "weekly" ? (
                  <table className="w-full border-collapse bg-white text-left text-sm">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">Week</th>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">
                          {periodValueLabel} ({unitLabel})
                        </th>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">WoW%</th>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">YoY%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {weeklyRows
                        .slice()
                        .reverse()
                        .map((w) => (
                          <tr key={w.weekStart} className="border-t border-slate-100">
                            <td className="px-3 py-2 font-medium text-slate-900">Week starting {formatDDMMYY(w.weekStart)}</td>
                            <td className="px-3 py-2 text-slate-700">{fmtValue(w.value)}</td>
                            <td className="px-3 py-2 text-slate-700">{fmtPct(w.wow_pct)}</td>
                            <td className="px-3 py-2 text-slate-700">{fmtPct(w.yoy_pct)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                ) : (
                  <table className="w-full border-collapse bg-white text-left text-sm">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">FY</th>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">
                          {periodValueLabel} ({unitLabel})
                        </th>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">YoY%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {yearlyFYRows
                        .slice()
                        .reverse()
                        .map((r) => (
                          <tr key={r.fy} className="border-t border-slate-100">
                            <td className="px-3 py-2 font-medium text-slate-900">{r.fy}</td>
                            <td className="px-3 py-2 text-slate-700">{fmtValue(r.value)}</td>
                            <td className="px-3 py-2 text-slate-700">{fmtPct(r.yoy_pct)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
