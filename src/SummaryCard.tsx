import React, { useEffect, useMemo, useState } from "react";

interface SummaryCardProps {
  rtmCsvUrl: string;
  supplyCsvUrl: string;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoMinusDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function isoPlusYears(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
}

/** Parse DD/MM/YY or DD/MM/YYYY → ISO YYYY-MM-DD */
function parseDDMMYY(s: string): string | null {
  const t = s.trim();
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  let yyyy = Number(m[3]);
  if (yyyy < 100) yyyy += 2000;
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
  return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function dayName(iso: string): string {
  return DAY_NAMES[new Date(iso + "T00:00:00Z").getUTCDay()];
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

function formatDisplayDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return `${ordinal(d.getUTCDate())} ${MONTH_FULL[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function formatDropdownLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return `${String(d.getUTCDate()).padStart(2, "0")}-${MONTH_NAMES[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

function isoYear(iso: string): number {
  return Number(iso.slice(0, 4));
}
function isoMonth(iso: string): number {
  return Number(iso.slice(5, 7));
}
function isoDay(iso: string): number {
  return Number(iso.slice(8, 10));
}

function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

// ── CSV parsers ───────────────────────────────────────────────────────────────

/** Parse RTM CSV → Map<isoDate, rtm_price> + sorted date list */
function parseRtmCsv(text: string): { map: Map<string, number>; dates: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const map = new Map<string, number>();
  let priceColIdx = 1; // default: column 1

  let startIdx = 0;
  if (lines[0].toLowerCase().includes("date")) {
    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
    priceColIdx = headers.findIndex((h) => h.includes("rtm_price") || h === "rtm price" || h === "price");
    if (priceColIdx < 0) priceColIdx = 1;
    startIdx = 1;
  }

  for (let i = startIdx; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const iso = parseDDMMYY(cols[0] ?? "");
    const val = parseFloat(cols[priceColIdx] ?? "");
    if (iso && Number.isFinite(val)) map.set(iso, val);
  }

  const dates = Array.from(map.keys()).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  return { map, dates };
}

/** Parse supply CSV (no header) → Map<isoDate, supply_gwh> */
function parseSupplyCsv(text: string): Map<string, number> {
  const map = new Map<string, number>();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let startIdx = 0;
  if (lines[0].toLowerCase().includes("date") || lines[0].toLowerCase().includes("supply")) {
    startIdx = 1;
  }
  for (let i = startIdx; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const iso = parseDDMMYY(cols[0] ?? "");
    const val = parseFloat(cols[1] ?? "");
    if (iso && Number.isFinite(val)) map.set(iso, val);
  }
  return map;
}

// ── Metric helpers ────────────────────────────────────────────────────────────

/**
 * Average of `days` values ending at (refIso - offsetDays).
 * Window: [refIso - offsetDays - days + 1 … refIso - offsetDays]
 */
function trailingAvg(
  map: Map<string, number>,
  refIso: string,
  days: number,
  offsetDays = 0
): number | null {
  const endIso = offsetDays > 0 ? isoMinusDays(refIso, offsetDays) : refIso;
  const startIso = isoMinusDays(endIso, days - 1);
  const vals: number[] = [];
  let cur = startIso;
  while (cur <= endIso) {
    const v = map.get(cur);
    if (v != null) vals.push(v);
    cur = isoMinusDays(cur, -1);
  }
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// Helper to advance one day
function isoAddDay(iso: string): string {
  return isoMinusDays(iso, -1);
}

/** Average of the last `count` occurrences of the same weekday BEFORE refIso */
function sameWeekdayAvg(
  map: Map<string, number>,
  refIso: string,
  count = 3
): number | null {
  const vals: number[] = [];
  for (let i = 1; i <= count; i++) {
    const d = isoMinusDays(refIso, i * 7);
    const v = map.get(d);
    if (v != null) vals.push(v);
  }
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Average of all values in a given month (optionally up to a specific day-of-month) */
function monthAvg(
  map: Map<string, number>,
  year: number,
  month: number,
  upToDay?: number
): number | null {
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  const vals: number[] = [];
  for (const [k, v] of map.entries()) {
    if (!k.startsWith(prefix)) continue;
    if (upToDay !== undefined && isoDay(k) > upToDay) continue;
    vals.push(v);
  }
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function growthPct(a: number | null, b: number | null): number | null {
  if (a == null || b == null || b === 0) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

/**
 * YoY%: compute trailingAvg for refIso and for refIso-365d, return growthPct.
 */
function trailingAvgYoY(
  map: Map<string, number>,
  refIso: string,
  days: number,
  offsetDays = 0
): number | null {
  const curr = trailingAvg(map, refIso, days, offsetDays);
  const prior = trailingAvg(map, isoMinusDays(refIso, 365), days, offsetDays);
  return growthPct(curr, prior);
}

function sameWeekdayAvgYoY(
  map: Map<string, number>,
  refIso: string,
  count = 3
): number | null {
  const curr = sameWeekdayAvg(map, refIso, count);
  const prior = sameWeekdayAvg(map, isoMinusDays(refIso, 365), count);
  return growthPct(curr, prior);
}

function monthAvgYoY(
  map: Map<string, number>,
  year: number,
  month: number,
  upToDay?: number
): number | null {
  const curr = monthAvg(map, year, month, upToDay);
  const prior = monthAvg(map, year - 1, month, upToDay);
  return growthPct(curr, prior);
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtPrice(n: number | null | undefined, decimals = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(decimals);
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
}

function pctClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "text-slate-400";
  return n >= 0 ? "text-emerald-600 font-semibold" : "text-red-500 font-semibold";
}

/** Sum of all values in map within [fromIso, toIso] inclusive */
function rangeSum(map: Map<string, number>, fromIso: string, toIso: string): number | null {
  let sum = 0; let count = 0;
  for (const [k, v] of map) {
    if (k >= fromIso && k <= toIso) { sum += v; count++; }
  }
  return count > 0 ? sum : null;
}

function direction(pct: number | null, threshold = 1): string {
  if (pct == null || !Number.isFinite(pct)) return "remained relatively flat";
  if (pct > threshold) return "rose";
  if (pct < -threshold) return "declined";
  return "remained relatively flat";
}

function upDown(curr: number | null, prev: number | null): string {
  if (curr == null || prev == null) return "remained stable";
  return curr > prev ? "improved" : curr < prev ? "declined" : "remained stable";
}

// ── News fetching ─────────────────────────────────────────────────────────────

type NewsItem = { title: string; url: string; source: string; publishedAtISO: string; snippet: string };

const NEWS_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

async function fetchPowerNews(toIso: string): Promise<NewsItem[]> {
  const cacheKey = `pwr_news_v5_${toIso}`;
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const { ts, items } = JSON.parse(cached);
      if (Date.now() - ts < NEWS_CACHE_TTL) return items;
    }
  } catch { /* ignore */ }

  // Dedicated endpoint — fetches RSS + generates AI summaries server-side
  const res = await fetch(`/api/news-summary?cb=${Date.now()}`);
  if (!res.ok) throw new Error("News API failed");
  const data = await res.json() as { items: Array<{ title: string; url: string; source: string; publishedAtISO: string; summary: string }> };
  const items: NewsItem[] = (data.items ?? []).map((i) => ({
    title: i.title,
    url: i.url,
    source: i.source,
    publishedAtISO: i.publishedAtISO,
    snippet: i.summary,
  }));

  if (items.length > 0) {
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), items }));
    } catch { /* ignore */ }
  }

  return items;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SummaryCard({ rtmCsvUrl, supplyCsvUrl }: SummaryCardProps) {
  const [rtmMap, setRtmMap] = useState<Map<string, number>>(new Map());
  const [allRtmDates, setAllRtmDates] = useState<string[]>([]);
  const [supplyMap, setSupplyMap] = useState<Map<string, number>>(new Map());
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [newsItems, setNewsItems] = useState<NewsItem[]>([]);
  const [newsLoading, setNewsLoading] = useState(false);
  const [showNews, setShowNews] = useState(true);

  useEffect(() => {
    Promise.all([fetch(rtmCsvUrl).then((r) => r.text()), fetch(supplyCsvUrl).then((r) => r.text())])
      .then(([rtmText, supplyText]) => {
        const { map: rMap, dates } = parseRtmCsv(rtmText);
        const sMap = parseSupplyCsv(supplyText);
        setRtmMap(rMap);
        setAllRtmDates(dates);
        setSupplyMap(sMap);

        // Default = most recent date <= yesterday
        const yesterday = isoMinusDays(todayISO(), 1);
        const def = dates.find((d) => d <= yesterday) ?? dates[0] ?? "";
        setSelectedDate(def);
      })
      .finally(() => setLoading(false));
  }, [rtmCsvUrl, supplyCsvUrl]);

  // ── Fetch news on date change ────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedDate) return;
    setNewsLoading(true);
    setNewsItems([]);
    fetchPowerNews(selectedDate)
      .then(setNewsItems)
      .catch(() => setNewsItems([]))
      .finally(() => setNewsLoading(false));
  }, [selectedDate]);

  // ── Compute all metrics ──────────────────────────────────────────────────────
  const metrics = useMemo(() => {
    if (!selectedDate) return null;
    const ref = selectedDate;
    const refDateObj = new Date(ref + "T00:00:00Z");
    const year = refDateObj.getUTCFullYear();
    const month = refDateObj.getUTCMonth() + 1; // 1-based
    const day = refDateObj.getUTCDate();
    const wdName = dayName(ref);

    // Prev months
    const pm1 = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
    const pm2 = pm1.m === 1 ? { y: pm1.y - 1, m: 12 } : { y: pm1.y, m: pm1.m - 1 };
    const pm3 = pm2.m === 1 ? { y: pm2.y - 1, m: 12 } : { y: pm2.y, m: pm2.m - 1 };

    // RTM metrics
    const rtm = {
      avg30: trailingAvg(rtmMap, ref, 30, 0),
      prev30: trailingAvg(rtmMap, ref, 30, 7),
      avg7: trailingAvg(rtmMap, ref, 7, 0),
      prevAvg7: trailingAvg(rtmMap, ref, 7, 7),
      refDay: rtmMap.get(ref) ?? null,
      weekday3Avg: sameWeekdayAvg(rtmMap, ref, 3),
      currMonthAvg: monthAvg(rtmMap, year, month, day),
      m1Avg: monthAvg(rtmMap, pm1.y, pm1.m),
      m2Avg: monthAvg(rtmMap, pm2.y, pm2.m),
      m3Avg: monthAvg(rtmMap, pm3.y, pm3.m),
    };

    // Supply YoY metrics
    const sup = {
      avg30Yoy: trailingAvgYoY(supplyMap, ref, 30, 0),
      prev30Yoy: trailingAvgYoY(supplyMap, ref, 30, 7),
      avg7Yoy: trailingAvgYoY(supplyMap, ref, 7, 0),
      prevAvg7Yoy: trailingAvgYoY(supplyMap, ref, 7, 7),
      refDayYoy: growthPct(supplyMap.get(ref) ?? null, supplyMap.get(isoMinusDays(ref, 365)) ?? null),
      weekday3Yoy: sameWeekdayAvgYoY(supplyMap, ref, 3),
      currMonthYoy: monthAvgYoY(supplyMap, year, month, day),
      m1Yoy: monthAvgYoY(supplyMap, pm1.y, pm1.m),
      m2Yoy: monthAvgYoY(supplyMap, pm2.y, pm2.m),
      m3Yoy: monthAvgYoY(supplyMap, pm3.y, pm3.m),
    };

    // FY YTD supply
    const fyStartYear = month >= 4 ? year : year - 1;
    const ytdStart = `${fyStartYear}-04-01`;
    const ytdSupCurr = rangeSum(supplyMap, ytdStart, ref);
    const ytdSupPrior = rangeSum(supplyMap, `${fyStartYear - 1}-04-01`, isoMinusDays(ref, 365));
    const ytdYoy = growthPct(ytdSupCurr, ytdSupPrior);
    const fyLabel = `Apr ${fyStartYear} – ${monthLabel(year, month)}`;

    // RTM WoW
    const avg30WoW = growthPct(rtm.avg30, rtm.prev30);
    const avg7WoW = growthPct(rtm.avg7, rtm.prevAvg7);
    const prev7DateLabel = formatDisplayDate(isoMinusDays(ref, 7));

    return { rtm, sup, wdName, year, month, day, pm1, pm2, pm3, ytdYoy, fyLabel, avg30WoW, avg7WoW, prev7DateLabel };
  }, [selectedDate, rtmMap, supplyMap]);

  // ── Excel download (exceljs — styled, single sheet) ──────────────────────────
  async function downloadExcel() {
    if (!metrics) return;
    const { rtm, sup, wdName, year, month, day, pm1, pm2, pm3, ytdYoy, fyLabel, avg30WoW, avg7WoW, prev7DateLabel } = metrics;

    // Dynamic import so exceljs doesn't bloat initial bundle
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Power Daily Update");

    ws.columns = [
      { key: "a", width: 36 },
      { key: "b", width: 16 },
      { key: "c", width: 16 },
    ];

    // ── Style helpers ──────────────────────────────────────────────────────────
    type Fill = { type: "pattern"; pattern: "solid"; fgColor: { argb: string } };
    const solidFill = (argb: string): Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

    function styleRow(
      row: ExcelJS.Row,
      opts: {
        bgArgb?: string;
        fontArgb?: string;
        bold?: boolean;
        fontSize?: number;
        numCols?: number;
      }
    ) {
      const n = opts.numCols ?? 3;
      for (let c = 1; c <= n; c++) {
        const cell = row.getCell(c);
        if (opts.bgArgb) cell.fill = solidFill(opts.bgArgb);
        cell.font = {
          bold: opts.bold ?? false,
          color: { argb: opts.fontArgb ?? "FF0F172A" },
          size: opts.fontSize ?? 11,
        };
        cell.alignment = { vertical: "middle", horizontal: c === 1 ? "left" : "right" };
        cell.border = {
          bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
        };
      }
    }

    function pctArgb(n: number | null | undefined): string {
      if (n == null || !Number.isFinite(n)) return "FF94A3B8";
      return n >= 0 ? "FF059669" : "FFEF4444";
    }

    // ── Title row ─────────────────────────────────────────────────────────────
    const titleRow = ws.addRow([`Power Daily Update — ${wdName} (${formatDisplayDate(selectedDate)})`, "", ""]);
    titleRow.height = 22;
    ws.mergeCells(`A${titleRow.number}:C${titleRow.number}`);
    styleRow(titleRow, { bold: true, fontSize: 13, bgArgb: "FFFFFFFF" });
    ws.addRow([]);

    // ── RTM section ───────────────────────────────────────────────────────────
    const rtmHdr = ws.addRow(["RTM Price Update", "", ""]);
    ws.mergeCells(`A${rtmHdr.number}:C${rtmHdr.number}`);
    styleRow(rtmHdr, { bgArgb: "FF84CC16", bold: true, fontArgb: "FF1A2E05" });

    const rtmColHdr = ws.addRow(["Metric", "₹/Per Unit", "% Change"]);
    styleRow(rtmColHdr, { bgArgb: "FF111827", fontArgb: "FFFFFFFF", bold: true });

    function addRtmDataRow(label: string, val: string, pctNum: number | null, isPrimary: boolean) {
      const row = ws.addRow([label, val, fmtPct(pctNum)]);
      row.height = 18;
      const bgArgb = isPrimary ? "FFF8FAFC" : "FFFFFFFF";
      styleRow(row, { bgArgb, fontArgb: isPrimary ? "FF0F172A" : "FF475569", bold: isPrimary });
      // Override pct cell color
      const pctCell = row.getCell(3);
      pctCell.font = { bold: true, color: { argb: pctArgb(pctNum) }, size: 11 };
    }

    function addSpacer() {
      ws.addRow([]).height = 6;
    }

    // Group 1
    addRtmDataRow("Avg Last 30 Days", fmtPrice(rtm.avg30), null, true);
    addRtmDataRow("Previous 30 Days Avg", fmtPrice(rtm.prev30), growthPct(rtm.avg30, rtm.prev30), false);
    addSpacer();
    // Group 2
    addRtmDataRow("Avg Last 7 Days", fmtPrice(rtm.avg7), null, true);
    addRtmDataRow("Avg Previous 7 Days", fmtPrice(rtm.prevAvg7), growthPct(rtm.avg7, rtm.prevAvg7), false);
    addSpacer();
    // Group 3
    addRtmDataRow(`${wdName} RTM Price`, fmtPrice(rtm.refDay), null, true);
    addRtmDataRow(`Avg Last 3 ${wdName}s`, fmtPrice(rtm.weekday3Avg), growthPct(rtm.refDay, rtm.weekday3Avg), false);
    addSpacer();
    // Group 4
    addRtmDataRow(`${monthLabel(year, month)} Monthly`, fmtPrice(rtm.currMonthAvg), null, true);
    addRtmDataRow(`${monthLabel(pm1.y, pm1.m)} Monthly Avg`, fmtPrice(rtm.m1Avg), growthPct(rtm.currMonthAvg, rtm.m1Avg), false);
    addRtmDataRow(`${monthLabel(pm2.y, pm2.m)} Monthly Avg`, fmtPrice(rtm.m2Avg), growthPct(rtm.currMonthAvg, rtm.m2Avg), false);
    addRtmDataRow(`${monthLabel(pm3.y, pm3.m)} Monthly Avg`, fmtPrice(rtm.m3Avg), growthPct(rtm.currMonthAvg, rtm.m3Avg), false);

    ws.addRow([]);
    ws.addRow([]);

    // ── Supply section ────────────────────────────────────────────────────────
    ws.columns[1].width = 16; // reset (only 2 cols for supply)
    const supHdr = ws.addRow(["Power Demand Update", "", ""]);
    ws.mergeCells(`A${supHdr.number}:B${supHdr.number}`);
    styleRow(supHdr, { bgArgb: "FF84CC16", bold: true, fontArgb: "FF1A2E05", numCols: 2 });

    const supColHdr = ws.addRow(["Metric", "YoY % Growth"]);
    styleRow(supColHdr, { bgArgb: "FF111827", fontArgb: "FFFFFFFF", bold: true, numCols: 2 });

    function addSupDataRow(label: string, pctNum: number | null, isPrimary: boolean) {
      const row = ws.addRow([label, fmtPct(pctNum)]);
      row.height = 18;
      const bgArgb = isPrimary ? "FFF8FAFC" : "FFFFFFFF";
      for (let c = 1; c <= 2; c++) {
        const cell = row.getCell(c);
        cell.fill = solidFill(bgArgb);
        cell.font = {
          bold: c === 1 ? isPrimary : true,
          color: { argb: c === 1 ? (isPrimary ? "FF0F172A" : "FF475569") : pctArgb(pctNum) },
          size: 11,
        };
        cell.alignment = { vertical: "middle", horizontal: c === 1 ? "left" : "right" };
        cell.border = { bottom: { style: "thin", color: { argb: "FFE2E8F0" } } };
      }
    }

    // Group 1
    addSupDataRow("Avg Last 30 Days", sup.avg30Yoy, true);
    addSupDataRow("Previous 30 Days Avg", sup.prev30Yoy, false);
    addSpacer();
    // Group 2
    addSupDataRow("Avg Last 7 Days", sup.avg7Yoy, true);
    addSupDataRow("Avg Previous 7 Days", sup.prevAvg7Yoy, false);
    addSpacer();
    // Group 3
    addSupDataRow(`${wdName} YoY Growth`, sup.refDayYoy, true);
    addSupDataRow(`Avg Last 3 ${wdName}s`, sup.weekday3Yoy, false);
    addSpacer();
    // Group 4
    addSupDataRow(`${monthLabel(year, month)} Monthly`, sup.currMonthYoy, true);
    addSupDataRow(`${monthLabel(pm1.y, pm1.m)} Monthly Avg`, sup.m1Yoy, false);
    addSupDataRow(`${monthLabel(pm2.y, pm2.m)} Monthly Avg`, sup.m2Yoy, false);
    addSupDataRow(`${monthLabel(pm3.y, pm3.m)} Monthly Avg`, sup.m3Yoy, false);

    // ── Download ──────────────────────────────────────────────────────────────
    const d = new Date(selectedDate + "T00:00:00Z");
    const fname = `Power_Daily_Update_${String(d.getUTCDate()).padStart(2, "0")}${MONTH_NAMES[d.getUTCMonth()]}${d.getUTCFullYear()}.xlsx`;
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fname;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── PDF download ─────────────────────────────────────────────────────────────
  async function downloadPDF() {
    const element = document.getElementById("summary-printable");
    if (!element) return;
    // Hide all no-print elements (toggle button, section wrapper when off, etc.)
    const noPrints = Array.from(element.querySelectorAll<HTMLElement>(".no-print"));
    noPrints.forEach((el) => (el.style.visibility = "hidden"));
    const html2canvas = (await import("html2canvas")).default;
    const { jsPDF } = await import("jspdf");
    const canvas = await html2canvas(element, { scale: 2, useCORS: true });
    noPrints.forEach((el) => (el.style.visibility = ""));
    const imgData = canvas.toDataURL("image/png");
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const imgH = (canvas.height * pageW) / canvas.width;
    let heightLeft = imgH;
    let pos = 0;
    pdf.addImage(imgData, "PNG", 0, pos, pageW, imgH);
    heightLeft -= pageH;
    while (heightLeft > 0) {
      pos -= pageH;
      pdf.addPage();
      pdf.addImage(imgData, "PNG", 0, pos, pageW, imgH);
      heightLeft -= pageH;
    }
    const d = new Date(selectedDate + "T00:00:00Z");
    const fname = `Power_Daily_Update_${String(d.getUTCDate()).padStart(2, "0")}${MONTH_NAMES[d.getUTCMonth()]}${d.getUTCFullYear()}.pdf`;
    pdf.save(fname);
  }

  // ── Render helpers ───────────────────────────────────────────────────────────
  function Spacer({ cols }: { cols: number }) {
    return (
      <tr>
        <td colSpan={cols} className="py-1" />
      </tr>
    );
  }

  function PctCell({ value }: { value: number | null | undefined }) {
    return <td className={`px-3 py-2 text-right tabular-nums ${pctClass(value)}`}>{fmtPct(value)}</td>;
  }

  if (loading) {
    return <div className="p-8 text-center text-slate-500">Loading summary data…</div>;
  }

  if (!metrics || !selectedDate) {
    return <div className="p-8 text-center text-slate-500">No data available.</div>;
  }

  const { rtm, sup, wdName, year, month, day, pm1, pm2, pm3, ytdYoy, fyLabel, avg30WoW, avg7WoW, prev7DateLabel } = metrics;
  const currMonthLabel = `${MONTH_FULL[month - 1]} ${year}`;

  return (
    <>
      {/* Print-only styles */}
      <div id="summary-printable" className="p-4 space-y-6">
        {/* ── Top bar ── */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-slate-900">
              Power Daily Update &mdash; {wdName} ({formatDisplayDate(selectedDate)})
            </h2>
          </div>
          <div className="no-print flex items-center gap-2">
            <label className="text-sm text-slate-600 font-medium">Date:</label>
            <input
              type="date"
              className="border border-slate-300 rounded px-2 py-1 text-sm bg-white"
              value={selectedDate}
              min={allRtmDates[allRtmDates.length - 1]}
              max={allRtmDates[0]}
              onChange={(e) => {
                const picked = e.target.value;
                if (!picked) return;
                const closest = allRtmDates.find((d) => d <= picked) ?? allRtmDates[0];
                setSelectedDate(closest);
              }}
            />
            <button
              onClick={() => downloadExcel().catch(console.error)}
              className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded"
            >
              ⬇ Excel
            </button>
            <button
              onClick={() => downloadPDF().catch(console.error)}
              className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium bg-slate-700 hover:bg-slate-800 text-white rounded"
            >
              🖨 PDF
            </button>
          </div>
        </div>

        {/* ── RTM Price Update ── */}
        <div>
          <div className="bg-lime-300 font-bold text-sm px-3 py-1.5 rounded-t">RTM Price Update</div>
          <table className="w-full border-collapse bg-white text-sm rounded-b overflow-hidden shadow-sm">
            <thead>
              <tr className="bg-gray-900 text-white">
                <th className="px-3 py-2 text-left font-semibold">Metric</th>
                <th className="px-3 py-2 text-right font-semibold">₹/Per Unit</th>
                <th className="px-3 py-2 text-right font-semibold">% Change</th>
              </tr>
            </thead>
            <tbody>
              {/* Group 1 */}
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 font-semibold text-slate-900">Avg Last 30 Days</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtPrice(rtm.avg30)}</td>
                <td className="px-3 py-2" />
              </tr>
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 text-slate-700">Previous 30 Days Avg</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtPrice(rtm.prev30)}</td>
                <PctCell value={growthPct(rtm.avg30, rtm.prev30)} />
              </tr>

              <Spacer cols={3} />

              {/* Group 2 */}
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 font-semibold text-slate-900">Avg Last 7 Days</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtPrice(rtm.avg7)}</td>
                <td className="px-3 py-2" />
              </tr>
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 text-slate-700">Avg Previous 7 Days</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtPrice(rtm.prevAvg7)}</td>
                <PctCell value={growthPct(rtm.avg7, rtm.prevAvg7)} />
              </tr>

              <Spacer cols={3} />

              {/* Group 3 */}
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 font-semibold text-slate-900">{wdName} RTM Price</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtPrice(rtm.refDay)}</td>
                <td className="px-3 py-2" />
              </tr>
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 text-slate-700">Avg Last 3 {wdName}s</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtPrice(rtm.weekday3Avg)}</td>
                <PctCell value={growthPct(rtm.refDay, rtm.weekday3Avg)} />
              </tr>

              <Spacer cols={3} />

              {/* Group 4 — Monthly */}
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 font-semibold text-slate-900">{currMonthLabel} Monthly</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtPrice(rtm.currMonthAvg)}</td>
                <td className="px-3 py-2" />
              </tr>
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 text-slate-700">{monthLabel(pm1.y, pm1.m)} Monthly Avg</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtPrice(rtm.m1Avg)}</td>
                <PctCell value={growthPct(rtm.currMonthAvg, rtm.m1Avg)} />
              </tr>
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 text-slate-700">{monthLabel(pm2.y, pm2.m)} Monthly Avg</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtPrice(rtm.m2Avg)}</td>
                <PctCell value={growthPct(rtm.currMonthAvg, rtm.m2Avg)} />
              </tr>
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 text-slate-700">{monthLabel(pm3.y, pm3.m)} Monthly Avg</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtPrice(rtm.m3Avg)}</td>
                <PctCell value={growthPct(rtm.currMonthAvg, rtm.m3Avg)} />
              </tr>
            </tbody>
          </table>
        </div>

        {/* ── Power Demand Update ── */}
        <div>
          <div className="bg-lime-300 font-bold text-sm px-3 py-1.5 rounded-t">Power Demand Update</div>
          <table className="w-full border-collapse bg-white text-sm rounded-b overflow-hidden shadow-sm">
            <thead>
              <tr className="bg-gray-900 text-white">
                <th className="px-3 py-2 text-left font-semibold">Metric</th>
                <th className="px-3 py-2 text-right font-semibold">YoY % Growth</th>
              </tr>
            </thead>
            <tbody>
              {/* Group 1 */}
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 font-semibold text-slate-900">Avg Last 30 Days</td>
                <PctCell value={sup.avg30Yoy} />
              </tr>
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 text-slate-700">Previous 30 Days Avg</td>
                <PctCell value={sup.prev30Yoy} />
              </tr>

              <Spacer cols={2} />

              {/* Group 2 */}
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 font-semibold text-slate-900">Avg Last 7 Days</td>
                <PctCell value={sup.avg7Yoy} />
              </tr>
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 text-slate-700">Avg Previous 7 Days</td>
                <PctCell value={sup.prevAvg7Yoy} />
              </tr>

              <Spacer cols={2} />

              {/* Group 3 */}
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 font-semibold text-slate-900">{wdName} YoY Growth</td>
                <PctCell value={sup.refDayYoy} />
              </tr>
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 text-slate-700">Avg Last 3 {wdName}s</td>
                <PctCell value={sup.weekday3Yoy} />
              </tr>

              <Spacer cols={2} />

              {/* Group 4 — Monthly */}
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 font-semibold text-slate-900">{currMonthLabel} Monthly</td>
                <PctCell value={sup.currMonthYoy} />
              </tr>
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 text-slate-700">{monthLabel(pm1.y, pm1.m)} Monthly Avg</td>
                <PctCell value={sup.m1Yoy} />
              </tr>
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 text-slate-700">{monthLabel(pm2.y, pm2.m)} Monthly Avg</td>
                <PctCell value={sup.m2Yoy} />
              </tr>
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 text-slate-700">{monthLabel(pm3.y, pm3.m)} Monthly Avg</td>
                <PctCell value={sup.m3Yoy} />
              </tr>
            </tbody>
          </table>
        </div>

        {/* ── Market Commentary ── */}
        <div className="border border-slate-200 rounded-lg p-4 bg-slate-50 space-y-3">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Market Commentary</div>

          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">RTM Price Summary</p>
          <p className="text-sm text-slate-800 leading-relaxed">
            The 30-day rolling RTM price{" "}
            <strong className="font-semibold text-slate-900">{direction(avg30WoW)}</strong>{" "}
            to{" "}
            <strong className="font-semibold text-slate-900">₹{fmtPrice(rtm.avg30)}/kWh</strong>{" "}
            as of {wdName} {formatDisplayDate(selectedDate)}, from{" "}
            <strong className="font-semibold text-slate-900">₹{fmtPrice(rtm.prev30)}/kWh</strong>{" "}
            on {prev7DateLabel} —{" "}
            <span className={pctClass(avg30WoW)}>{fmtPct(avg30WoW)} WoW</span>.
          </p>
          <p className="text-sm text-slate-800 leading-relaxed">
            The 7-day average RTM price{" "}
            <strong className="font-semibold text-slate-900">{direction(avg7WoW)}</strong>{" "}
            to{" "}
            <strong className="font-semibold text-slate-900">₹{fmtPrice(rtm.avg7)}/kWh</strong>,
            compared to{" "}
            <strong className="font-semibold text-slate-900">₹{fmtPrice(rtm.prevAvg7)}/kWh</strong>{" "}
            last week (<span className={pctClass(avg7WoW)}>{fmtPct(avg7WoW)}</span>).
          </p>

          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mt-1">Demand Summary</p>
          <p className="text-sm text-slate-800 leading-relaxed">
            The rolling 30-day average power demand{" "}
            <strong className="font-semibold text-slate-900">{upDown(sup.avg30Yoy, sup.prev30Yoy)}</strong>{" "}
            to{" "}
            <span className={pctClass(sup.avg30Yoy)}>{fmtPct(sup.avg30Yoy)} YoY</span>,{" "}
            {sup.avg30Yoy != null && sup.prev30Yoy != null ? (sup.avg30Yoy > sup.prev30Yoy ? "up" : "down") : ""}{" "}
            from{" "}
            <span className={pctClass(sup.prev30Yoy)}>{fmtPct(sup.prev30Yoy)} YoY</span> a week ago.
          </p>
          <p className="text-sm text-slate-800 leading-relaxed">
            As of {formatDisplayDate(selectedDate)}, Year-to-Date ({fyLabel}) power demand growth stands at{" "}
            <span className={pctClass(ytdYoy)}><strong className="font-semibold">{fmtPct(ytdYoy)} YoY</strong></span>.{" "}
            The 7-day average demand growth is{" "}
            <span className={pctClass(sup.avg7Yoy)}>{fmtPct(sup.avg7Yoy)} YoY</span>.
          </p>
        </div>

        {/* ── Key Power Updates ── */}
        <div className={showNews ? "" : "no-print"}>
          <div className="flex items-center justify-between gap-3 bg-blue-50 border-l-4 border-blue-400 px-3 py-1.5">
            <div className="text-sm font-semibold text-blue-800">
              Other key developments in the Indian power sector — Last 30 days as on {formatDisplayDate(selectedDate)}
            </div>
            <button
              onClick={() => setShowNews((v: boolean) => !v)}
              className={`shrink-0 text-xs px-3 py-1 rounded-full font-medium border transition-colors no-print ${
                showNews
                  ? "bg-white text-blue-700 border-blue-200 hover:bg-blue-50"
                  : "bg-slate-100 text-slate-500 border-slate-200 hover:bg-slate-200"
              }`}
            >
              {showNews ? "Hide from export" : "Show in export"}
            </button>
          </div>
          {showNews && (
            <div className="mt-2 space-y-3">
              {newsLoading && (
                <p className="text-sm text-slate-500 px-1">Loading news…</p>
              )}
              {!newsLoading && newsItems.length === 0 && (
                <p className="text-sm text-slate-500 px-1">No recent news found for this date range.</p>
              )}
              {!newsLoading && newsItems.map((item, i) => {
                const pubDate = new Date(item.publishedAtISO);
                const dateStr = `${ordinal(pubDate.getUTCDate())} ${MONTH_NAMES[pubDate.getUTCMonth()]} ${pubDate.getUTCFullYear()}`;
                return (
                  <div key={i} className="flex gap-2 text-sm">
                    <span className="text-slate-400 font-semibold shrink-0">{i + 1}.</span>
                    <div>
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-slate-800 hover:text-blue-700 hover:underline font-medium"
                      >
                        {item.title}
                      </a>
                      <span className="text-xs text-slate-500 ml-1">— {item.source} · {dateStr}</span>
                      {item.snippet && (
                        <p className="text-sm text-slate-600 mt-1 leading-relaxed">{item.snippet}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
