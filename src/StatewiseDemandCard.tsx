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
  state: string
) {
  if (!sortedKeys.length) return { latest: null, avg30: null, yoy: null };

  const latest = rows.get(sortedKeys[sortedKeys.length - 1])?.[state] ?? null;

  // 30-day avg
  const last30 = sortedKeys.slice(-30);
  const vals30 = last30.map((k) => rows.get(k)?.[state]).filter((v): v is number => v !== undefined);
  const avg30 = vals30.length ? Math.round(vals30.reduce((a, b) => a + b, 0) / vals30.length) : null;

  // YoY: same day last year
  const lastKey = sortedKeys[sortedKeys.length - 1];
  const [y, m, d] = lastKey.split("-").map(Number);
  const yoyKey = `${y - 1}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  // Find nearest key around yoyKey (within ±3 days)
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

  return { latest, avg30, yoy };
}

// ── Custom Tooltip ────────────────────────────────────────────────────────────

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200 shadow-lg text-xs">
      <div className="mb-1 font-semibold text-slate-700">{fmtTooltipDate(label)}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span style={{ color: p.color }}>●</span>
          <span className="text-slate-600">{p.dataKey}:</span>
          <span className="font-semibold text-slate-800">{p.value?.toLocaleString()} MU</span>
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
    // Compute rolling avgs
    const avgs: Record<string, Map<string, number>> = {};
    if (showAvg) {
      for (const s of selectedStates) avgs[s] = rollingAvg(sortedKeys, filteredRows, s, 30);
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
  }, [sortedKeys, filteredRows, selectedStates, showAvg]);

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
            {/* Rolling avg toggle */}
            <label className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-slate-50 px-2.5 py-1.5 ring-1 ring-slate-200 text-xs font-medium text-slate-700 select-none">
              <input
                type="checkbox"
                checked={showAvg}
                onChange={(e) => setShowAvg(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-300"
              />
              30-day avg
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
                onClick={() => {
                  // Top 5 states by latest value
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
                    tickFormatter={(v) => `${(v / 1000).toFixed(1)}k`}
                    width={46}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend
                    wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                    formatter={(val) =>
                      val.endsWith("_avg") ? `${val.replace("_avg", "")} (30d avg)` : val
                    }
                  />
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
                      {showAvg && (
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
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="px-4 py-2.5 text-left font-semibold text-slate-500">State</th>
                    <th className="px-4 py-2.5 text-right font-semibold text-slate-500">Latest (MU)</th>
                    <th className="px-4 py-2.5 text-right font-semibold text-slate-500">30-day Avg (MU)</th>
                    <th className="px-4 py-2.5 text-right font-semibold text-slate-500">YoY %</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedStates.map((s, i) => {
                    const stats = computeStats(sortedKeys, filteredRows, s);
                    const yoyPositive = stats.yoy !== null && stats.yoy >= 0;
                    return (
                      <tr key={s} className="border-b border-slate-50 hover:bg-slate-50">
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-2 font-medium text-slate-700">
                            <span
                              className="inline-block h-2.5 w-2.5 rounded-full flex-shrink-0"
                              style={{ backgroundColor: getStateColor(i) }}
                            />
                            {s}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-right font-semibold text-slate-800">
                          {stats.latest !== null ? stats.latest.toLocaleString() : "—"}
                        </td>
                        <td className="px-4 py-2 text-right text-slate-600">
                          {stats.avg30 !== null ? stats.avg30.toLocaleString() : "—"}
                        </td>
                        <td className={`px-4 py-2 text-right font-semibold ${
                          stats.yoy === null ? "text-slate-400" :
                          yoyPositive ? "text-emerald-600" : "text-red-600"
                        }`}>
                          {stats.yoy !== null
                            ? `${yoyPositive ? "+" : ""}${stats.yoy.toFixed(1)}%`
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
