import React, { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";

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

// ── Main component ────────────────────────────────────────────────────────────

export default function SummaryCard({ rtmCsvUrl, supplyCsvUrl }: SummaryCardProps) {
  const [rtmMap, setRtmMap] = useState<Map<string, number>>(new Map());
  const [allRtmDates, setAllRtmDates] = useState<string[]>([]);
  const [supplyMap, setSupplyMap] = useState<Map<string, number>>(new Map());
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [loading, setLoading] = useState(true);

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

    return { rtm, sup, wdName, year, month, day, pm1, pm2, pm3 };
  }, [selectedDate, rtmMap, supplyMap]);

  // ── Excel download ───────────────────────────────────────────────────────────
  function downloadExcel() {
    if (!metrics) return;
    const { rtm, sup, wdName, year, month, day, pm1, pm2, pm3 } = metrics;

    const rtmRows = [
      ["Metric", "₹/Per Unit", "% Change"],
      ["Avg Last 30 Days", fmtPrice(rtm.avg30), ""],
      ["Previous 30 Days Avg (shifted 7d)", fmtPrice(rtm.prev30), fmtPct(growthPct(rtm.avg30, rtm.prev30))],
      [],
      ["Avg Last 7 Days", fmtPrice(rtm.avg7), ""],
      ["Avg Previous 7 Days", fmtPrice(rtm.prevAvg7), fmtPct(growthPct(rtm.avg7, rtm.prevAvg7))],
      [],
      [`${wdName} RTM Price`, fmtPrice(rtm.refDay), ""],
      [`Avg Last 3 ${wdName}s`, fmtPrice(rtm.weekday3Avg), fmtPct(growthPct(rtm.refDay, rtm.weekday3Avg))],
      [],
      [`${monthLabel(year, month)} Monthly`, fmtPrice(rtm.currMonthAvg), ""],
      [`${monthLabel(pm1.y, pm1.m)} Monthly Avg`, fmtPrice(rtm.m1Avg), fmtPct(growthPct(rtm.currMonthAvg, rtm.m1Avg))],
      [`${monthLabel(pm2.y, pm2.m)} Monthly Avg`, fmtPrice(rtm.m2Avg), fmtPct(growthPct(rtm.currMonthAvg, rtm.m2Avg))],
      [`${monthLabel(pm3.y, pm3.m)} Monthly Avg`, fmtPrice(rtm.m3Avg), fmtPct(growthPct(rtm.currMonthAvg, rtm.m3Avg))],
    ];

    const supRows = [
      ["Metric", "YoY % Growth"],
      ["Avg Last 30 Days", fmtPct(sup.avg30Yoy)],
      ["Previous 30 Days Avg (shifted 7d)", fmtPct(sup.prev30Yoy)],
      [],
      ["Avg Last 7 Days", fmtPct(sup.avg7Yoy)],
      ["Avg Previous 7 Days", fmtPct(sup.prevAvg7Yoy)],
      [],
      [`${wdName} YoY Growth`, fmtPct(sup.refDayYoy)],
      [`Avg Last 3 ${wdName}s`, fmtPct(sup.weekday3Yoy)],
      [],
      [`${monthLabel(year, month)} Monthly`, fmtPct(sup.currMonthYoy)],
      [`${monthLabel(pm1.y, pm1.m)} Monthly Avg`, fmtPct(sup.m1Yoy)],
      [`${monthLabel(pm2.y, pm2.m)} Monthly Avg`, fmtPct(sup.m2Yoy)],
      [`${monthLabel(pm3.y, pm3.m)} Monthly Avg`, fmtPct(sup.m3Yoy)],
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rtmRows), "RTM Price Update");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(supRows), "Power Demand Update");
    const d = new Date(selectedDate + "T00:00:00Z");
    const fname = `Power_Daily_Update_${String(d.getUTCDate()).padStart(2, "0")}${MONTH_NAMES[d.getUTCMonth()]}${d.getUTCFullYear()}.xlsx`;
    XLSX.writeFile(wb, fname);
  }

  // ── PDF download ─────────────────────────────────────────────────────────────
  function downloadPDF() {
    window.print();
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

  const { rtm, sup, wdName, year, month, day, pm1, pm2, pm3 } = metrics;
  const currMonthLabel = `${MONTH_FULL[month - 1]} ${year}`;

  return (
    <>
      {/* Print-only styles */}
      <style>{`
        @media print {
          body > * { display: none !important; }
          #summary-printable { display: block !important; position: static !important; }
          .no-print { display: none !important; }
        }
      `}</style>

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
            <select
              className="border border-slate-300 rounded px-2 py-1 text-sm bg-white"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
            >
              {allRtmDates.map((d) => (
                <option key={d} value={d}>
                  {formatDropdownLabel(d)}
                </option>
              ))}
            </select>
            <button
              onClick={downloadExcel}
              className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded"
            >
              ⬇ Excel
            </button>
            <button
              onClick={downloadPDF}
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
      </div>
    </>
  );
}
