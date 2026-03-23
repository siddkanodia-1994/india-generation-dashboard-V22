import React, { useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";

// ── Constants ─────────────────────────────────────────────────────────────────

const STATE_COLORS = [
  "#2563eb", "#9333ea", "#0f766e", "#f59e0b", "#ef4444",
  "#16a34a", "#db2777", "#475569", "#c2410c", "#0891b2",
  "#7c3aed", "#65a30d", "#b45309", "#0284c7", "#be185d",
];

function getStateColor(i: number) {
  return STATE_COLORS[i % STATE_COLORS.length];
}

const RANGE_OPTIONS = [
  { label: "Last 90 days",  days: 90  },
  { label: "Last 6 months", days: 180 },
  { label: "Last 1 year",   days: 365 },
  { label: "Last 2 years",  days: 730 },
  { label: "All",           days: 0   },
] as const;

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Parse DD/MM/YY → sortable YYYY-MM-DD key */
function parseDateKey(raw: string): string | null {
  const parts = raw.trim().split("/");
  if (parts.length !== 3) return null;
  const [d, m, y] = parts.map(Number);
  if (!d || !m || !y) return null;
  const year = y < 100 ? 2000 + y : y;
  return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Format YYYY-MM-DD for X-axis display */
function fmtXLabel(key: string): string {
  const [, m, d] = key.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d} ${months[parseInt(m, 10) - 1]}`;
}

/** Format YYYY-MM-DD as DD Mon YY for tooltip */
function fmtTooltipDate(key: string): string {
  const [y, m, d] = key.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d} ${months[parseInt(m, 10) - 1]} ${String(parseInt(y, 10)).slice(2)}`;
}

// ── CSV parsing ───────────────────────────────────────────────────────────────

type ParsedData = {
  states: string[];
  rows: Map<string, Record<string, number>>; // dateKey → {state: mu}
};

function parseStatewiseCsv(text: string): ParsedData {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { states: [], rows: new Map() };

  const headers = lines[0].split(",");
  const states = headers.slice(1).map((s) => s.trim()).filter(Boolean);
  const rows = new Map<string, Record<string, number>>();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (!cols[0]?.trim()) continue;
    const dateKey = parseDateKey(cols[0].trim());
    if (!dateKey) continue;
    const entry: Record<string, number> = {};
    for (let j = 0; j < states.length; j++) {
      const v = parseFloat(cols[j + 1]);
      if (!isNaN(v) && v > 0) entry[states[j]] = v;
    }
    rows.set(dateKey, entry);
  }

  return { states, rows };
}

// ── Rolling average ───────────────────────────────────────────────────────────

function rollingAvg(sortedKeys: string[], rows: Map<string, Record<string, number>>, state: string, window = 30): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < sortedKeys.length; i++) {
    const slice = sortedKeys.slice(Math.max(0, i - window + 1), i + 1);
    const vals = slice.map((k) => rows.get(k)?.[state]).filter((v): v is number => v !== undefined);
    if (vals.length > 0) {
      out.set(sortedKeys[i], Math.round(vals.reduce((a, b) => a + b, 0) / vals.length));
    }
  }
  return out;
}

// ── Summary stats ─────────────────────────────────────────────────────────────

function computeStats(
  sortedKeys: string[],
  rows: Map<string, Record<string, number>>,
  state: string,
  avgWindow: number = 30
) {
  if (!sortedKeys.length) return { latest: null, avgN: null, yoy: null };

  const latest = rows.get(sortedKeys[sortedKeys.length - 1])?.[state] ?? null;

  // N-day avg
  const lastN = sortedKeys.slice(-avgWindow);
  const valsN = lastN.map((k) => rows.get(k)?.[state]).filter((v): v is number => v !== undefined);
  const avgN = valsN.length ? Math.round(valsN.reduce((a, b) => a + b, 0) / valsN.length) : null;

  // YoY: same day last year (search within ±3 days)
  const lastKey = sortedKeys[sortedKeys.length - 1];
  const [y, m, d] = lastKey.split("-").map(Number);
  let yoyVal: number | null = null;
  for (let delta = 0; delta <= 3; delta++) {
    for (const sign of [0, 1, -1]) {
      const tryDate = new Date(y - 1, m - 1, d + sign * delta);
      const tryKey = tryDate.toISOString().slice(0, 10);
      const v = rows.get(tryKey)?.[state];
      if (v !== undefined) { yoyVal = v; break; }
    }
    if (yoyVal !== null) break;
  }
  const yoy = latest !== null && yoyVal !== null ? ((latest - yoyVal) / yoyVal) * 100 : null;

  return { latest, avgN, yoy };
}

/** Avg-based YoY: current N-day avg vs same N-day avg 1 year ago */
function computeAvgYoY(
  sortedKeys: string[],
  rows: Map<string, Record<string, number>>,
  state: string,
  avgWindow: number
): number | null {
  const windowKeys = sortedKeys.slice(-avgWindow);
  if (!windowKeys.length) return null;

  const currentVals = windowKeys
    .map((k) => rows.get(k)?.[state])
    .filter((v): v is number => v !== undefined);
  if (!currentVals.length) return null;
  const currentAvg = currentVals.reduce((a, b) => a + b, 0) / currentVals.length;

  // For each day in window, find the same calendar date 1 year ago (±3 day search)
  const yoyVals: number[] = [];
  for (const k of windowKeys) {
    const [y, m, d] = k.split("-").map(Number);
    let found = false;
    for (let delta = 0; delta <= 3 && !found; delta++) {
      for (const sign of [0, 1, -1]) {
        const tryDate = new Date(y - 1, m - 1, d + sign * delta);
        const tryKey = tryDate.toISOString().slice(0, 10);
        const v = rows.get(tryKey)?.[state];
        if (v !== undefined) { yoyVals.push(v); found = true; break; }
      }
    }
  }
  if (!yoyVals.length) return null;
  const yoyAvg = yoyVals.reduce((a, b) => a + b, 0) / yoyVals.length;
  if (yoyAvg === 0) return null;
  return ((currentAvg - yoyAvg) / yoyAvg) * 100;
}

/** Single-day market share: state value / All-India total for that day */
function computeLatestShare(
  lastKey: string,
  rows: Map<string, Record<string, number>>,
  state: string,
  allStates: string[]
): number | null {
  const row = rows.get(lastKey);
  if (!row) return null;
  const sv = row[state];
  if (sv === undefined) return null;
  const total = allStates.reduce((acc, s) => acc + (row[s] ?? 0), 0);
  if (total <= 0) return null;
  return (sv / total) * 100;
}

function computeMarketShare(
  sortedKeys: string[],
  rows: Map<string, Record<string, number>>,
  state: string,
  allStates: string[],
  avgWindow: number
): number | null {
  const windowKeys = sortedKeys.slice(-avgWindow);
  if (!windowKeys.length) return null;

  let stateSum = 0, allSum = 0, count = 0;
  for (const k of windowKeys) {
    const row = rows.get(k);
    if (!row) continue;
    const sv = row[state];
    if (sv === undefined) continue;
    const total = allStates.reduce((acc, s) => acc + (row[s] ?? 0), 0);
    if (total <= 0) continue;
    stateSum += sv;
    allSum += total;
    count++;
  }
  if (count === 0 || allSum === 0) return null;
  return (stateSum / allSum) * 100;
}

// ── Custom Tooltip ────────────────────────────────────────────────────────────

function CustomTooltip({ active, payload, label, showYoY }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200 shadow-lg text-xs">
      <div className="mb-1 font-semibold text-slate-700">{fmtTooltipDate(label)}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span style={{ color: p.color }}>●</span>
          <span className="text-slate-600">{p.dataKey}:</span>
          <span className="font-semibold text-slate-800">
            {showYoY
              ? `${p.value >= 0 ? "+" : ""}${p.value?.toFixed(1)}% YoY`
              : `${p.value?.toLocaleString()} MU`}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function StatewiseDemandCard() {
  const [data, setData] = useState<ParsedData>({ states: [], rows: new Map() });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedStates, setSelectedStates] = useState<string[]>([]);
  const [rangeIdx, setRangeIdx] = useState(2); // default: Last 1 year
  const [showAvg, setShowAvg] = useState(false);
  const [avgWindow, setAvgWindow] = useState<7 | 14 | 30 | 45>(30);
  const [showYoY, setShowYoY] = useState(false);
  type SortKey = 'state' | 'latest' | 'shareLatest' | 'yoy' | 'avgN' | 'avgYoY' | 'share';
  const [sortConfig, setSortConfig] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);
  const handleSort = (key: SortKey) =>
    setSortConfig((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' }
    );
  const sortIcon = (key: SortKey) =>
    sortConfig?.key === key
      ? sortConfig.dir === 'asc' ? ' ▲' : ' ▼'
      : ' ⇅';

  // Load CSV
  useEffect(() => {
    setLoading(true);
    fetch("/data/statewise_demand.csv")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        const parsed = parseStatewiseCsv(text);
        setData(parsed);
        // Default: select top 5 states by latest day's value
        if (parsed.states.length) {
          const sortedKeys = Array.from(parsed.rows.keys()).sort();
          const lastKey = sortedKeys[sortedKeys.length - 1];
          const lastRow = parsed.rows.get(lastKey) ?? {};
          const top5 = parsed.states
            .filter((s) => lastRow[s] !== undefined)
            .sort((a, b) => (lastRow[b] ?? 0) - (lastRow[a] ?? 0))
            .slice(0, 5);
          setSelectedStates(top5);
        }
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, []);

  // Filter by date range
  const { sortedKeys, filteredRows } = useMemo(() => {
    const allKeys = Array.from(data.rows.keys()).sort();
    const rangeDays = RANGE_OPTIONS[rangeIdx].days;
    const sliced = rangeDays === 0 ? allKeys : allKeys.slice(-rangeDays);
    return { sortedKeys: sliced, filteredRows: data.rows };
  }, [data, rangeIdx]);

  // Build chart data
  const chartData = useMemo(() => {
    if (!selectedStates.length) return [];

    if (showYoY) {
      // YoY% mode: replace absolute MU with (today - sameDay1YrAgo) / sameDay1YrAgo × 100
      return sortedKeys.map((key) => {
        const [y, m, d] = key.split("-").map(Number);
        const point: Record<string, any> = { date: key };
        for (const s of selectedStates) {
          const currentVal = filteredRows.get(key)?.[s];
          if (currentVal === undefined) continue;
          let yoyVal: number | undefined;
          for (let delta = 0; delta <= 3 && !yoyVal; delta++) {
            for (const sign of [0, 1, -1]) {
              const tryDate = new Date(y - 1, m - 1, d + sign * delta);
              const tryKey = tryDate.toISOString().slice(0, 10);
              const v = filteredRows.get(tryKey)?.[s];
              if (v !== undefined) { yoyVal = v; break; }
            }
          }
          if (currentVal && yoyVal) {
            point[s] = parseFloat(((currentVal - yoyVal) / yoyVal * 100).toFixed(2));
          }
        }
        return point;
      });
    }

    // Normal mode
    const avgs: Record<string, Map<string, number>> = {};
    if (showAvg) {
      for (const s of selectedStates) avgs[s] = rollingAvg(sortedKeys, filteredRows, s, avgWindow);
    }
    return sortedKeys.map((key) => {
      const row = filteredRows.get(key) ?? {};
      const point: Record<string, any> = { date: key };
      for (const s of selectedStates) {
        if (row[s] !== undefined) point[s] = row[s];
        if (showAvg && avgs[s]?.has(key)) point[`${s}_avg`] = avgs[s].get(key);
      }
      return point;
    });
  }, [sortedKeys, filteredRows, selectedStates, showAvg, showYoY, avgWindow]);

  // X-axis tick formatter — show ~6–10 ticks
  const xTickFormatter = (val: string) => fmtXLabel(val);

  // X-axis tick interval
  const tickInterval = Math.max(1, Math.floor(sortedKeys.length / 8));

  if (loading) {
    return (
      <div className="mt-4 flex items-center justify-center rounded-2xl bg-white p-10 ring-1 ring-slate-200">
        <span className="text-sm text-slate-500">Loading statewise demand data…</span>
      </div>
    );
  }

  if (error || !data.states.length) {
    return (
      <div className="mt-4 rounded-2xl bg-white p-6 ring-1 ring-slate-200">
        <div className="text-sm text-red-600">
          {error ?? "No data available. Run the backfill script to populate statewise_demand.csv."}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-3">
      {/* Header */}
      <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-base font-semibold text-slate-800">Statewise Power Demand</div>
            <div className="text-xs text-slate-500">Daily power supply in MU for each state (Grid India PSP)</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Rolling avg toggle — label updates with avgWindow */}
            <label className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-slate-50 px-2.5 py-1.5 ring-1 ring-slate-200 text-xs font-medium text-slate-700 select-none">
              <input
                type="checkbox"
                checked={showAvg}
                onChange={(e) => setShowAvg(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-300"
              />
              {avgWindow}-day avg
            </label>
            {/* Date range */}
            <select
              value={rangeIdx}
              onChange={(e) => setRangeIdx(Number(e.target.value))}
              className="rounded-xl border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700"
            >
              {RANGE_OPTIONS.map((o, i) => (
                <option key={o.label} value={i}>{o.label}</option>
              ))}
            </select>
            {/* YoY% chart toggle */}
            <label className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-slate-50 px-2.5 py-1.5 ring-1 ring-slate-200 text-xs font-medium text-slate-700 select-none">
              <input
                type="checkbox"
                checked={showYoY}
                onChange={(e) => setShowYoY(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-300"
              />
              YoY%
            </label>
          </div>
        </div>
      </div>

      {/* Body: state selector + chart */}
      <div className="flex flex-col gap-3 lg:flex-row">
        {/* State selector */}
        <div className="lg:w-[260px] lg:shrink-0">
          <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
            <div className="text-xs font-semibold text-slate-700">Select States</div>
            <div className="mt-2 max-h-[420px] overflow-auto rounded-xl bg-white ring-1 ring-slate-200">
              <div className="grid grid-cols-1 gap-1.5 p-2 text-[12px] text-slate-700">
                {data.states.map((s) => {
                  const checked = selectedStates.includes(s);
                  const colorIdx = selectedStates.indexOf(s);
                  return (
                    <label key={s} className="flex items-center gap-2 cursor-pointer hover:bg-slate-50 rounded px-1 py-0.5">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const on = e.target.checked;
                          setSelectedStates((prev) => {
                            if (on) return Array.from(new Set([...prev, s]));
                            return prev.filter((x) => x !== s);
                          });
                        }}
                        className="h-4 w-4 rounded border-slate-300"
                      />
                      {checked && (
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: getStateColor(colorIdx) }}
                        />
                      )}
                      <span className="font-medium">{s}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            {/* Quick actions */}
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setSelectedStates([...data.states])}
                className="rounded-lg bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
              >
                All
              </button>
              <button
                type="button"
                onClick={() => {
                  const allKeys = Array.from(data.rows.keys()).sort();
                  const lastKey = allKeys[allKeys.length - 1];
                  const lastRow = data.rows.get(lastKey) ?? {};
                  const top5 = data.states
                    .filter((s) => lastRow[s] !== undefined)
                    .sort((a, b) => (lastRow[b] ?? 0) - (lastRow[a] ?? 0))
                    .slice(0, 5);
                  setSelectedStates(top5);
                }}
                className="rounded-lg bg-slate-900 px-2 py-1 text-[11px] font-semibold text-white hover:bg-slate-800"
              >
                Top 5
              </button>
              <button
                type="button"
                onClick={() => {
                  const allKeys = Array.from(data.rows.keys()).sort();
                  const lastKey = allKeys[allKeys.length - 1];
                  const lastRow = data.rows.get(lastKey) ?? {};
                  const top3 = data.states
                    .filter((s) => lastRow[s] !== undefined)
                    .sort((a, b) => (lastRow[b] ?? 0) - (lastRow[a] ?? 0))
                    .slice(0, 3);
                  setSelectedStates(top3);
                }}
                className="rounded-lg bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
              >
                Top 3
              </button>
              <button
                type="button"
                onClick={() => setSelectedStates([])}
                className="rounded-lg bg-white px-2 py-1 text-[11px] font-semibold text-rose-700 ring-1 ring-slate-200 hover:bg-slate-50"
              >
                Clear
              </button>
            </div>
          </div>
        </div>

        {/* Chart area */}
        <div className="min-w-0 flex-1">
          <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
            {selectedStates.length === 0 ? (
              <div className="flex h-[380px] items-center justify-center text-sm text-slate-400">
                Select one or more states from the panel to view their demand trend.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={380}>
                <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={xTickFormatter}
                    interval={tickInterval}
                    tick={{ fontSize: 11, fill: "#64748b" }}
                    axisLine={{ stroke: "#e2e8f0" }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "#64748b" }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={showYoY
                      ? (v) => `${v.toFixed(1)}%`
                      : (v) => `${(v / 1000).toFixed(1)}k`
                    }
                    width={46}
                  />
                  <Tooltip content={<CustomTooltip showYoY={showYoY} />} />
                  <Legend
                    wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                    formatter={(val) =>
                      val.endsWith("_avg") ? `${val.replace("_avg", "")} (${avgWindow}d avg)` : val
                    }
                  />
                  {/* Zero reference line in YoY mode */}
                  {showYoY && (
                    <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
                  )}
                  {selectedStates.map((s, i) => (
                    <React.Fragment key={s}>
                      <Line
                        type="monotone"
                        dataKey={s}
                        stroke={getStateColor(i)}
                        strokeWidth={1.5}
                        dot={false}
                        connectNulls={false}
                        name={s}
                      />
                      {/* Rolling avg lines only in normal MU mode */}
                      {showAvg && !showYoY && (
                        <Line
                          type="monotone"
                          dataKey={`${s}_avg`}
                          stroke={getStateColor(i)}
                          strokeWidth={2.5}
                          strokeDasharray="4 2"
                          dot={false}
                          connectNulls
                          name={`${s}_avg`}
                        />
                      )}
                    </React.Fragment>
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Summary table */}
          {selectedStates.length > 0 && (
            <div className="mt-3 overflow-x-auto rounded-2xl bg-white ring-1 ring-slate-200">
              {/* Table toolbar */}
              <div className="flex items-center justify-between px-4 py-2 border-b border-slate-100">
                <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Summary</span>
                <select
                  value={avgWindow}
                  onChange={(e) => setAvgWindow(Number(e.target.value) as 7 | 14 | 30 | 45)}
                  className="rounded-xl border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700"
                >
                  <option value={7}>Last 7-day Avg</option>
                  <option value={14}>Last 14-day Avg</option>
                  <option value={30}>Last 30-day Avg</option>
                  <option value={45}>Last 45-day Avg</option>
                </select>
              </div>
              {(() => {
                // Pre-compute all row data so we can sort
                const lastKey = sortedKeys[sortedKeys.length - 1];
                const rawRows = selectedStates.map((s, originalIdx) => {
                  const stats = computeStats(sortedKeys, filteredRows, s, avgWindow);
                  const latestShare = lastKey ? computeLatestShare(lastKey, filteredRows, s, data.states) : null;
                  const avgYoY = computeAvgYoY(sortedKeys, filteredRows, s, avgWindow);
                  const share = computeMarketShare(sortedKeys, filteredRows, s, data.states, avgWindow);
                  return { s, originalIdx, stats, latestShare, avgYoY, share };
                });
                const tableRows = sortConfig
                  ? [...rawRows].sort((a, b) => {
                      let av: number | string | null, bv: number | string | null;
                      switch (sortConfig.key) {
                        case 'state':       av = a.s;             bv = b.s;             break;
                        case 'latest':      av = a.stats.latest;  bv = b.stats.latest;  break;
                        case 'shareLatest': av = a.latestShare;   bv = b.latestShare;   break;
                        case 'yoy':         av = a.stats.yoy;     bv = b.stats.yoy;     break;
                        case 'avgN':        av = a.stats.avgN;    bv = b.stats.avgN;    break;
                        case 'avgYoY':      av = a.avgYoY;        bv = b.avgYoY;        break;
                        case 'share':       av = a.share;         bv = b.share;         break;
                        default: return 0;
                      }
                      if (av === null) return 1;
                      if (bv === null) return -1;
                      if (typeof av === 'string') return sortConfig.dir === 'asc' ? av.localeCompare(bv as string) : (bv as string).localeCompare(av);
                      return sortConfig.dir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number);
                    })
                  : rawRows;

                const thClass = "px-4 py-2.5 text-right font-semibold text-slate-500 cursor-pointer select-none hover:text-slate-700 whitespace-nowrap";
                return (
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th onClick={() => handleSort('state')} className="px-4 py-2.5 text-left font-semibold text-slate-500 cursor-pointer select-none hover:text-slate-700 whitespace-nowrap">
                          State<span className="text-slate-300">{sortIcon('state')}</span>
                        </th>
                        <th onClick={() => handleSort('latest')} className={thClass}>
                          Latest (MU)
                          {sortedKeys.length > 0 && (
                            <span className="ml-1 font-normal text-slate-400">· {fmtXLabel(sortedKeys[sortedKeys.length - 1])}</span>
                          )}
                          <span className="text-slate-300">{sortIcon('latest')}</span>
                        </th>
                        <th onClick={() => handleSort('shareLatest')} className={thClass}>
                          Share (Latest)<span className="text-slate-300">{sortIcon('shareLatest')}</span>
                        </th>
                        <th onClick={() => handleSort('yoy')} className={thClass}>
                          YoY% (Latest)<span className="text-slate-300">{sortIcon('yoy')}</span>
                        </th>
                        <th onClick={() => handleSort('avgN')} className={thClass}>
                          {avgWindow}-day Avg (MU)<span className="text-slate-300">{sortIcon('avgN')}</span>
                        </th>
                        <th onClick={() => handleSort('avgYoY')} className={thClass}>
                          {avgWindow}d Avg YoY%<span className="text-slate-300">{sortIcon('avgYoY')}</span>
                        </th>
                        <th onClick={() => handleSort('share')} className={thClass}>
                          Market Share<span className="text-slate-300">{sortIcon('share')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {tableRows.map(({ s, originalIdx, stats, latestShare, avgYoY, share }) => {
                        const yoyPositive = stats.yoy !== null && stats.yoy >= 0;
                        const avgYoYPositive = avgYoY !== null && avgYoY >= 0;
                        return (
                          <tr key={s} className="border-b border-slate-50 hover:bg-slate-50">
                            <td className="px-4 py-2">
                              <div className="flex items-center gap-2 font-medium text-slate-700">
                                <span
                                  className="inline-block h-2.5 w-2.5 rounded-full flex-shrink-0"
                                  style={{ backgroundColor: getStateColor(originalIdx) }}
                                />
                                {s}
                              </div>
                            </td>
                            <td className="px-4 py-2 text-right font-semibold text-slate-800">
                              {stats.latest !== null ? stats.latest.toLocaleString() : "—"}
                            </td>
                            <td className="px-4 py-2 text-right text-slate-500">
                              {latestShare !== null ? `${latestShare.toFixed(1)}%` : "—"}
                            </td>
                            <td className={`px-4 py-2 text-right font-semibold ${
                              stats.yoy === null ? "text-slate-400" :
                              yoyPositive ? "text-emerald-600" : "text-red-600"
                            }`}>
                              {stats.yoy !== null ? `${yoyPositive ? "+" : ""}${stats.yoy.toFixed(1)}%` : "—"}
                            </td>
                            <td className="px-4 py-2 text-right text-slate-600">
                              {stats.avgN !== null ? stats.avgN.toLocaleString() : "—"}
                            </td>
                            <td className={`px-4 py-2 text-right font-semibold ${
                              avgYoY === null ? "text-slate-400" :
                              avgYoYPositive ? "text-emerald-600" : "text-red-600"
                            }`}>
                              {avgYoY !== null ? `${avgYoYPositive ? "+" : ""}${avgYoY.toFixed(1)}%` : "—"}
                            </td>
                            <td className="px-4 py-2 text-right text-slate-500">
                              {share !== null ? `${share.toFixed(1)}%` : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    {/* Total row */}
                    <tfoot>
                      <tr className="border-t-2 border-slate-200 bg-slate-50">
                        <td className="px-4 py-2.5 font-semibold text-slate-700">Total (selected)</td>
                    {/* Latest total */}
                    <td className="px-4 py-2.5 text-right font-semibold text-slate-800">
                      {(() => {
                        const lastKey = sortedKeys[sortedKeys.length - 1];
                        const lastRow = lastKey ? filteredRows.get(lastKey) : undefined;
                        const total = selectedStates.reduce((acc, s) => acc + (lastRow?.[s] ?? 0), 0);
                        return total > 0 ? total.toLocaleString(undefined, { maximumFractionDigits: 1 }) : "—";
                      })()}
                    </td>
                    {/* Share (Latest) for total */}
                    <td className="px-4 py-2.5 text-right font-semibold text-slate-700">
                      {(() => {
                        const lastKey = sortedKeys[sortedKeys.length - 1];
                        if (!lastKey) return "—";
                        const lastRow = filteredRows.get(lastKey);
                        if (!lastRow) return "—";
                        const allIndia = data.states.reduce((acc, s) => acc + (lastRow[s] ?? 0), 0);
                        if (allIndia <= 0) return "—";
                        const selTotal = selectedStates.reduce((acc, s) => acc + (lastRow[s] ?? 0), 0);
                        return `${((selTotal / allIndia) * 100).toFixed(1)}%`;
                      })()}
                    </td>
                    {/* YoY% (Latest) for total */}
                    <td className="px-4 py-2.5 text-right font-semibold">
                      {(() => {
                        const lastKey = sortedKeys[sortedKeys.length - 1];
                        if (!lastKey) return <span className="text-slate-400">—</span>;
                        const lastRow = filteredRows.get(lastKey);
                        const totalLatest = selectedStates.reduce((acc, s) => acc + (lastRow?.[s] ?? 0), 0);
                        // Find same day last year
                        const [y, m, d] = lastKey.split("-").map(Number);
                        let totalYoy = 0;
                        let yoyFound = false;
                        for (let delta = 0; delta <= 3; delta++) {
                          for (const sign of [0, 1, -1]) {
                            const tryDate = new Date(y - 1, m - 1, d + sign * delta);
                            const tryKey = tryDate.toISOString().slice(0, 10);
                            const tryRow = filteredRows.get(tryKey);
                            if (tryRow) {
                              totalYoy = selectedStates.reduce((acc, s) => acc + (tryRow[s] ?? 0), 0);
                              if (totalYoy > 0) { yoyFound = true; break; }
                            }
                          }
                          if (yoyFound) break;
                        }
                        if (!yoyFound || totalYoy === 0) return <span className="text-slate-400">—</span>;
                        const pct = ((totalLatest - totalYoy) / totalYoy) * 100;
                        const pos = pct >= 0;
                        return <span className={pos ? "text-emerald-600" : "text-red-600"}>{pos ? "+" : ""}{pct.toFixed(1)}%</span>;
                      })()}
                    </td>
                    {/* N-day avg total */}
                    <td className="px-4 py-2.5 text-right font-semibold text-slate-700">
                      {(() => {
                        const windowKeys = sortedKeys.slice(-avgWindow);
                        if (!windowKeys.length) return "—";
                        let sum = 0, count = 0;
                        for (const k of windowKeys) {
                          const row = filteredRows.get(k);
                          if (!row) continue;
                          const dayTotal = selectedStates.reduce((acc, s) => acc + (row[s] ?? 0), 0);
                          if (dayTotal > 0) { sum += dayTotal; count++; }
                        }
                        return count > 0 ? Math.round(sum / count).toLocaleString() : "—";
                      })()}
                    </td>
                    {/* YoY% (Avg) for total */}
                    <td className="px-4 py-2.5 text-right font-semibold">
                      {(() => {
                        const windowKeys = sortedKeys.slice(-avgWindow);
                        if (!windowKeys.length) return <span className="text-slate-400">—</span>;
                        // Current avg sum
                        let currentSum = 0, currentCount = 0;
                        for (const k of windowKeys) {
                          const row = filteredRows.get(k);
                          if (!row) continue;
                          const dayTotal = selectedStates.reduce((acc, s) => acc + (row[s] ?? 0), 0);
                          if (dayTotal > 0) { currentSum += dayTotal; currentCount++; }
                        }
                        if (currentCount === 0) return <span className="text-slate-400">—</span>;
                        const currentAvg = currentSum / currentCount;
                        // Prior year avg sum
                        const yoyTotals: number[] = [];
                        for (const k of windowKeys) {
                          const [y, m, d] = k.split("-").map(Number);
                          let found = false;
                          for (let delta = 0; delta <= 3 && !found; delta++) {
                            for (const sign of [0, 1, -1]) {
                              const tryDate = new Date(y - 1, m - 1, d + sign * delta);
                              const tryKey = tryDate.toISOString().slice(0, 10);
                              const tryRow = filteredRows.get(tryKey);
                              if (tryRow) {
                                const dayTotal = selectedStates.reduce((acc, s) => acc + (tryRow[s] ?? 0), 0);
                                if (dayTotal > 0) { yoyTotals.push(dayTotal); found = true; break; }
                              }
                            }
                          }
                        }
                        if (!yoyTotals.length) return <span className="text-slate-400">—</span>;
                        const yoyAvg = yoyTotals.reduce((a, b) => a + b, 0) / yoyTotals.length;
                        if (yoyAvg === 0) return <span className="text-slate-400">—</span>;
                        const pct = ((currentAvg - yoyAvg) / yoyAvg) * 100;
                        const pos = pct >= 0;
                        return <span className={pos ? "text-emerald-600" : "text-red-600"}>{pos ? "+" : ""}{pct.toFixed(1)}%</span>;
                      })()}
                    </td>
                    {/* Market share total */}
                    <td className="px-4 py-2.5 text-right font-semibold text-slate-700">
                      {(() => {
                        const shares = selectedStates.map((s) =>
                          computeMarketShare(sortedKeys, filteredRows, s, data.states, avgWindow)
                        );
                        const total = shares.reduce((acc, v) => acc + (v ?? 0), 0);
                        return shares.some((v) => v !== null) ? `${total.toFixed(1)}%` : "—";
                      })()}
                    </td>
                  </tr>
                    </tfoot>
                  </table>
                );
              })()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
