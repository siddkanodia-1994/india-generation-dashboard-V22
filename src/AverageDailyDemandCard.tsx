import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

// ── Constants ─────────────────────────────────────────────────────────────────

const SOURCES = ["thermal", "solar", "wind", "hydro", "nuclear", "gas", "storage", "others"] as const;
type Source = typeof SOURCES[number];

const SOURCE_LABELS: Record<Source, string> = {
  thermal: "Thermal",
  solar:   "Solar",
  wind:    "Wind",
  hydro:   "Hydro",
  nuclear: "Nuclear",
  gas:     "Gas",
  storage: "Storage",
  others:  "Others",
};

const SOURCE_COLORS: Record<Source, string> = {
  thermal: "#b45309",
  solar:   "#ca8a04",
  wind:    "#0891b2",
  hydro:   "#0369a1",
  nuclear: "#7c3aed",
  gas:     "#ea580c",
  storage: "#0f766e",
  others:  "#64748b",
};

const RANGE_OPTIONS = [
  { label: "Last 30 days",  days: 30  },
  { label: "Last 90 days",  days: 90  },
  { label: "Last 6 months", days: 180 },
  { label: "All",           days: 0   },
] as const;

// ── PLF card constants ────────────────────────────────────────────────────────

type PLFSource = "Coal" | "Oil & Gas" | "Nuclear" | "Hydro" | "Solar" | "Wind" | "Bio Power";
const PLF_SOURCES: PLFSource[] = ["Coal", "Oil & Gas", "Nuclear", "Hydro", "Solar", "Wind", "Bio Power"];

const PLF_TO_AVG: Record<PLFSource, keyof Pick<AvgDailyRow, "thermal"|"gas"|"nuclear"|"hydro"|"solar"|"wind"|"others">> = {
  "Coal":      "thermal",
  "Oil & Gas": "gas",
  "Nuclear":   "nuclear",
  "Hydro":     "hydro",
  "Solar":     "solar",
  "Wind":      "wind",
  "Bio Power": "others",
};

const PLF_COL_LABELS: Record<PLFSource, string> = {
  "Coal":      "Coal",
  "Oil & Gas": "Oil & Gas",
  "Nuclear":   "Nuclear",
  "Hydro":     "Hydro*",
  "Solar":     "Solar",
  "Wind":      "Wind",
  "Bio Power": "Others†",
};

const PLF_MAINT_KEY = "peakDemandPLF_maint";
const PLF_PCT_KEY   = "peakDemandPLF_plfPct";
const DEFAULT_MAINT = 5;
const MAINT_PRESETS = [0, 2, 5, 8, 10, 15, 20];

const DEFAULT_PLF_PCT: Record<PLFSource, number> = {
  "Coal":      85,
  "Oil & Gas": 25,
  "Nuclear":   85,
  "Hydro":     40,
  "Solar":     20,
  "Wind":      25,
  "Bio Power": 60,
};

async function fetchCapacityForDate(dateKey: string): Promise<Record<PLFSource, number>> {
  const res = await fetch("/data/capacity.csv");
  if (!res.ok) throw new Error(`capacity.csv HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error("empty capacity.csv");
  const header = lines[0].replace(/^﻿/, "").split(",").map(h => h.trim().toLowerCase());

  const targetMonth = dateKey.slice(0, 7); // "YYYY-MM"
  type CapRow = Record<PLFSource, number>;
  const entries: Array<[string, CapRow]> = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(c => c.trim());
    const parts = cols[0]?.split("/");
    if (!parts || parts.length !== 3) continue;
    const [, m, y] = parts.map(Number);
    if (!m || !y) continue;
    const year = y < 100 ? 2000 + y : y;
    const monthKey = `${year}-${String(m).padStart(2, "0")}`;
    const col = (name: string) => {
      const idx = header.indexOf(name.toLowerCase());
      return idx >= 0 ? parseFloat(cols[idx] ?? "0") || 0 : 0;
    };
    entries.push([monthKey, {
      "Coal":      col("coal"),
      "Oil & Gas": col("oil & gas"),
      "Nuclear":   col("nuclear"),
      "Hydro":     col("hydro") + col("small-hydro"),
      "Solar":     col("solar"),
      "Wind":      col("wind"),
      "Bio Power": col("bio power"),
    }]);
  }

  if (entries.length === 0) throw new Error("no capacity rows");
  entries.sort((a, b) => a[0].localeCompare(b[0]));

  // Last entry with monthKey <= targetMonth; fallback to most recent
  let best = entries[entries.length - 1];
  for (const entry of entries) {
    if (entry[0] <= targetMonth) best = entry;
    else break;
  }
  return best[1];
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface AvgDailyRow {
  dateKey:   string;
  dateLabel: string;
  nuclear:   number;
  wind:      number;
  solar:     number;
  hydro:     number;
  gas:       number;
  thermal:   number;
  storage:   number;
  others:    number;
  total:     number;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function parseDateKey(raw: string): string | null {
  const parts = raw.trim().split("/");
  if (parts.length !== 3) return null;
  const [d, m, y] = parts.map(Number);
  if (!d || !m || !y) return null;
  const year = y < 100 ? 2000 + y : y;
  return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function fmtDateLabel(key: string): string {
  const [y, m, d] = key.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d} ${months[parseInt(m, 10) - 1]} ${String(parseInt(y, 10)).slice(2)}`;
}

function fmtXLabel(key: string): string {
  const [, m, d] = key.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d} ${months[parseInt(m, 10) - 1]}`;
}

// ── CSV parsing ───────────────────────────────────────────────────────────────

function parseCsv(text: string): AvgDailyRow[] {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map(h => h.trim());
  const rows: AvgDailyRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(c => c.trim());
    if (cols.length < 9) continue;
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => { obj[h] = cols[idx] ?? ""; });

    const rawDate = obj["date"] ?? "";
    const dateKey = parseDateKey(rawDate);
    if (!dateKey) continue;

    const num = (k: string) => parseFloat(obj[k] ?? "0") || 0;

    rows.push({
      dateKey,
      dateLabel: fmtDateLabel(dateKey),
      nuclear:  num("nuclear_avg_gw"),
      wind:     num("wind_avg_gw"),
      solar:    num("solar_avg_gw"),
      hydro:    num("hydro_avg_gw"),
      gas:      num("gas_avg_gw"),
      thermal:  num("thermal_avg_gw"),
      storage:  num("storage_avg_gw"),
      others:   num("others_avg_gw"),
      total:    num("total_avg_gw"),
    });
  }

  return rows.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

// ── Avg Daily PLF Card ────────────────────────────────────────────────────────

function AvgDailyPLFCard({ rows }: { rows: AvgDailyRow[] }) {
  const latest = rows.length > 0 ? rows[rows.length - 1] : null;
  const [plfDate, setPlfDate] = useState<string | null>(null);
  const kpiRow = plfDate ? (rows.find(r => r.dateKey === plfDate) ?? latest) : latest;

  const [capacity, setCapacity] = useState<Record<PLFSource, number>>(
    () => Object.fromEntries(PLF_SOURCES.map(s => [s, 0])) as Record<PLFSource, number>
  );

  const [maint, setMaint] = useState<Record<PLFSource, number>>(() => {
    try {
      const raw = localStorage.getItem(PLF_MAINT_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        const out = {} as Record<PLFSource, number>;
        for (const s of PLF_SOURCES) out[s] = Number(obj[s]) ?? DEFAULT_MAINT;
        return out;
      }
    } catch {}
    return Object.fromEntries(PLF_SOURCES.map(s => [s, DEFAULT_MAINT])) as Record<PLFSource, number>;
  });

  const [plfPct, setPlfPct] = useState<Record<PLFSource, number>>(() => {
    try {
      const raw = localStorage.getItem(PLF_PCT_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        const out = {} as Record<PLFSource, number>;
        for (const s of PLF_SOURCES) out[s] = Number(obj[s]) ?? DEFAULT_PLF_PCT[s];
        return out;
      }
    } catch {}
    return { ...DEFAULT_PLF_PCT };
  });

  const kpiMonth = kpiRow?.dateKey?.slice(0, 7) ?? null;

  useEffect(() => {
    if (!kpiMonth) return;
    fetchCapacityForDate(kpiMonth).then(setCapacity).catch(() => {});
  }, [kpiMonth]);

  const reloadCapacity = useCallback(() => {
    if (!kpiMonth) return;
    fetchCapacityForDate(kpiMonth).then(setCapacity).catch(() => {});
  }, [kpiMonth]);

  useEffect(() => {
    try { localStorage.setItem(PLF_MAINT_KEY, JSON.stringify(maint)); } catch {}
  }, [maint]);

  useEffect(() => {
    try { localStorage.setItem(PLF_PCT_KEY, JSON.stringify(plfPct)); } catch {}
  }, [plfPct]);

  const availCap = useMemo(() => {
    const out = {} as Record<PLFSource, number>;
    for (const s of PLF_SOURCES) out[s] = capacity[s] * (1 - maint[s] / 100);
    return out;
  }, [capacity, maint]);

  const ratedCap = useMemo(() => {
    const out = {} as Record<PLFSource, number>;
    for (const s of PLF_SOURCES) out[s] = capacity[s] * plfPct[s] / 100;
    return out;
  }, [capacity, plfPct]);

  const capTotal   = PLF_SOURCES.reduce((sum, s) => sum + (capacity[s] || 0), 0);
  const availTotal = PLF_SOURCES.reduce((sum, s) => sum + availCap[s], 0);
  const ratedTotal = PLF_SOURCES.reduce((sum, s) => sum + ratedCap[s], 0);

  const avgGW = useMemo(() => {
    const out = {} as Record<PLFSource, number>;
    for (const s of PLF_SOURCES) out[s] = kpiRow ? kpiRow[PLF_TO_AVG[s]] : 0;
    return out;
  }, [kpiRow]);

  const avgPLF = useMemo(() => {
    const out = {} as Record<PLFSource, number | null>;
    for (const s of PLF_SOURCES) out[s] = availCap[s] > 0 ? (avgGW[s] / availCap[s]) * 100 : null;
    return out;
  }, [avgGW, availCap]);

  const totalGW  = kpiRow?.total ?? null;
  const totalPLF = totalGW != null && ratedTotal > 0 ? (totalGW / ratedTotal) * 100 : null;

  const inputCls = "w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-right text-sm text-slate-900 outline-none focus:ring-2 focus:ring-slate-300 tabular-nums";
  const kpiDateLabel = kpiRow?.dateLabel ?? "—";
  const isSpotlight  = plfDate !== null && kpiRow?.dateKey !== latest?.dateKey;
  const fmtPLF = (v: number | null) => v === null ? "—" : `${v.toFixed(1)}%`;

  return (
    <div className="mt-6 bg-white rounded-2xl shadow-sm ring-1 ring-slate-200">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 p-4">
        <div>
          <div className="text-sm font-semibold text-slate-800">Avg Daily PLF</div>
          <div className="text-xs text-slate-500 mt-0.5">
            Plant Load Factor based on daily average generation · {kpiDateLabel}
            {isSpotlight && <span className="ml-1 text-blue-500 font-semibold">· selected</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-400 whitespace-nowrap">Date</span>
            <input
              type="date"
              value={plfDate ?? ""}
              min={rows[0]?.dateKey}
              max={latest?.dateKey}
              onChange={e => setPlfDate(e.target.value || null)}
              className="text-xs border border-slate-200 rounded-lg px-2 py-1 text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 cursor-pointer"
            />
            {plfDate && (
              <button
                onClick={() => setPlfDate(null)}
                className="text-xs text-slate-400 hover:text-slate-600 px-1"
                title="Clear date"
              >
                ✕
              </button>
            )}
          </div>
          <button
            onClick={reloadCapacity}
            className="text-xs text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg px-2 py-1 bg-white hover:bg-slate-50"
          >
            Reload capacity
          </button>
        </div>
      </div>

      <div className="p-4">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50">
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700 w-[200px]">Metric</th>
                {PLF_SOURCES.map(s => (
                  <th key={s} className="px-2 py-2 text-right text-xs font-semibold text-slate-700 whitespace-nowrap">
                    {PLF_COL_LABELS[s]}
                  </th>
                ))}
                <th className="px-3 py-2 text-right text-xs font-semibold text-slate-700">Total</th>
              </tr>
            </thead>
            <tbody>
              {/* Row 1: Installed Capacity */}
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 font-semibold text-slate-800 text-xs">Installed Capacity (GW)</td>
                {PLF_SOURCES.map(s => (
                  <td key={s} className="px-2 py-1.5">
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={capacity[s]}
                      onChange={e => {
                        const v = parseFloat(e.target.value) || 0;
                        setCapacity(prev => ({ ...prev, [s]: v }));
                      }}
                      className={inputCls}
                    />
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900 text-sm">
                  {capTotal.toFixed(0)}
                </td>
              </tr>

              {/* Row 2: Maintenance % */}
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 text-xs">
                  <div className="font-semibold text-slate-800">Maintenance (%)</div>
                  {(() => {
                    const firstVal = maint[PLF_SOURCES[0]];
                    const allEqual = PLF_SOURCES.every(s => maint[s] === firstVal);
                    const isPreset = MAINT_PRESETS.includes(firstVal);
                    const globalVal = allEqual && isPreset ? String(firstVal) : "";
                    const isCustom  = !allEqual || !isPreset;
                    return (
                      <select
                        value={globalVal}
                        onChange={e => {
                          const v = parseFloat(e.target.value);
                          if (!isNaN(v))
                            setMaint(Object.fromEntries(PLF_SOURCES.map(s => [s, v])) as Record<PLFSource, number>);
                        }}
                        className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 outline-none focus:ring-2 focus:ring-slate-300"
                      >
                        {isCustom && <option value="">Custom</option>}
                        {MAINT_PRESETS.map(v => (
                          <option key={v} value={String(v)}>{v}% — all sources</option>
                        ))}
                      </select>
                    );
                  })()}
                </td>
                {PLF_SOURCES.map(s => (
                  <td key={s} className="px-2 py-1.5">
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      max="100"
                      value={maint[s]}
                      onChange={e => {
                        const v = Math.min(100, Math.max(0, parseFloat(e.target.value) || 0));
                        setMaint(prev => ({ ...prev, [s]: v }));
                      }}
                      className={inputCls}
                    />
                  </td>
                ))}
                <td className="px-3 py-2 text-right text-slate-500 text-sm">—</td>
              </tr>

              {/* Row 3: PLF % */}
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2 text-xs">
                  <div className="font-semibold text-slate-800">PLF (%)</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">Used to derive rated capacity</div>
                </td>
                {PLF_SOURCES.map(s => (
                  <td key={s} className="px-2 py-1.5">
                    <input
                      type="number"
                      step="1"
                      min="0"
                      max="100"
                      value={plfPct[s]}
                      onChange={e => {
                        const v = Math.min(100, Math.max(0, parseFloat(e.target.value) || 0));
                        setPlfPct(prev => ({ ...prev, [s]: v }));
                      }}
                      className={inputCls}
                    />
                  </td>
                ))}
                <td className="px-3 py-2 text-right text-slate-500 text-sm">—</td>
              </tr>

              {/* Row 4: Rated Capacity */}
              <tr className="border-t border-slate-100 bg-slate-50/60">
                <td className="px-3 py-2 text-xs">
                  <div className="font-semibold text-slate-800">Rated Capacity (GW)</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">Installed × PLF% · total = denominator for Total PLF%</div>
                </td>
                {PLF_SOURCES.map(s => (
                  <td key={s} className="px-3 py-2 text-right font-mono text-sm text-slate-600 tabular-nums">
                    {ratedCap[s].toFixed(1)}
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900 text-sm">
                  {ratedTotal.toFixed(1)}
                </td>
              </tr>

              {/* Row 5: Avg Daily GW */}
              <tr className="border-t border-slate-100 bg-blue-50/40">
                <td className="px-3 py-2 font-semibold text-slate-800 text-xs">
                  Avg Daily GW
                  <div className="text-[10px] font-normal text-slate-500 mt-0.5">
                    {kpiDateLabel} · mean of 96 × 15-min intervals
                  </div>
                </td>
                {PLF_SOURCES.map(s => (
                  <td key={s} className="px-3 py-2 text-right font-mono text-sm text-slate-900 tabular-nums">
                    {(avgGW[s] ?? 0).toFixed(2)}
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900 text-sm">
                  {totalGW != null ? totalGW.toFixed(2) : "—"}
                </td>
              </tr>

              {/* Row 4: Avg Daily PLF % */}
              <tr className="border-t border-slate-100 bg-blue-50/70">
                <td className="px-3 py-2 font-bold text-slate-900 text-xs">Avg Daily PLF %</td>
                {PLF_SOURCES.map(s => (
                  <td key={s} className="px-3 py-2 text-right font-semibold tabular-nums text-sm text-slate-900">
                    {fmtPLF(avgPLF[s])}
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-bold tabular-nums text-slate-900 text-sm">
                  {fmtPLF(totalPLF)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="mt-3 space-y-0.5 text-[11px] text-slate-500">
          <div>Per-source PLF% = Avg Daily GW ÷ (Installed Capacity × (1 − Maintenance%/100)) × 100.</div>
          <div>Total PLF% = Total Avg Daily GW ÷ Rated Capacity total (Installed × PLF%) × 100. PLF%, capacity, and maintenance values are editable and saved in your browser (shared with Demand Source tab).</div>
          <div>Total GW = column C daily average from Grid India TimeSeries (includes net exports/imports); source columns sum may differ slightly.</div>
          <div>* Hydro column combines Hydro and Small-Hydro installed capacity from capacity.csv; GW = combined hydro avg output.</div>
          <div>† Others/Bio Power column = residual "Others" category (column K); values before mid-2025 show 0.0 due to PSP Excel format change.</div>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AverageDailyDemandCard() {
  const [rows, setRows] = useState<AvgDailyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rangeDays, setRangeDays] = useState<number>(30);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [showPct, setShowPct] = useState(false);

  useEffect(() => {
    fetch("/data/average_daily_demand.csv")
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
      .then(text => { setRows(parseCsv(text)); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  const filtered = useMemo(() => {
    if (rangeDays === 0) return rows;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - rangeDays);
    const cutoffKey = cutoff.toISOString().slice(0, 10);
    return rows.filter(r => r.dateKey >= cutoffKey);
  }, [rows, rangeDays]);

  const latest = filtered[filtered.length - 1];

  const kpiRow = useMemo(() => {
    if (!selectedDate) return latest;
    return rows.find(r => r.dateKey === selectedDate) ?? latest;
  }, [selectedDate, rows, latest]);

  const chartData = filtered.map(r => ({
    label:   fmtXLabel(r.dateKey),
    dateKey: r.dateKey,
    ...Object.fromEntries(SOURCES.map(s => [s, r[s]])),
  }));

  const isSpotlight = selectedDate !== null && kpiRow?.dateKey !== latest?.dateKey;

  const customTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    const row = filtered.find(r => fmtXLabel(r.dateKey) === label);
    return (
      <div className="bg-white border border-gray-200 rounded shadow-lg p-3 text-xs">
        <div className="font-semibold text-gray-700 mb-1">{label}</div>
        {payload.slice().reverse().map((p: any) => (
          <div key={p.dataKey} className="flex justify-between gap-4">
            <span style={{ color: p.color }}>{SOURCE_LABELS[p.dataKey as Source]}</span>
            <span className="font-mono">{p.value?.toFixed(2)} GW</span>
          </div>
        ))}
        <div className="border-t border-gray-200 mt-1 pt-1">
          <div className="flex justify-between font-semibold">
            <span>Avg Total Demand</span>
            <span className="font-mono">{row?.total.toFixed(2) ?? "—"} GW</span>
          </div>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
        Loading average daily demand data…
      </div>
    );
  }

  if (error || rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-gray-400 text-sm">
        {error ? `Error: ${error}` : "No data available yet."}
      </div>
    );
  }

  return (
    <div className="mt-4">
      {/* Header + controls */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-bold text-gray-800">Average Daily Demand — Source Breakdown</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Daily average of all 96 × 15-min TimeSeries intervals · source mix in GW
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-1.5 flex-wrap">
            {RANGE_OPTIONS.map(opt => (
              <button
                key={opt.days}
                onClick={() => setRangeDays(opt.days)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  rangeDays === opt.days
                    ? "bg-blue-600 text-white"
                    : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-50"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* GW / % toggle */}
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            <button
              onClick={() => setShowPct(false)}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                !showPct ? "bg-blue-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              GW
            </button>
            <button
              onClick={() => setShowPct(true)}
              className={`px-3 py-1 text-xs font-medium transition-colors border-l border-gray-200 ${
                showPct ? "bg-blue-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              %
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-400 whitespace-nowrap">Jump to</span>
            <input
              type="date"
              value={selectedDate ?? ""}
              min={rows[0]?.dateKey}
              max={rows[rows.length - 1]?.dateKey}
              onChange={e => setSelectedDate(e.target.value || null)}
              className="text-xs border border-gray-200 rounded-lg px-2 py-1 text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 cursor-pointer"
            />
            {selectedDate && (
              <button
                onClick={() => setSelectedDate(null)}
                className="text-xs text-gray-400 hover:text-gray-600 px-1"
                title="Clear date"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        {/* KPI badges */}
        {kpiRow && (
          <div className="mb-4">
            <div className="text-xs text-gray-500 mb-2 font-medium uppercase tracking-wide flex items-center gap-2">
              <span>
                {kpiRow.dateLabel} · Avg Total Demand {kpiRow.total.toFixed(2)} GW
              </span>
              {isSpotlight && (
                <span className="text-blue-500 font-semibold normal-case">· selected</span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {SOURCES.map(s => {
                const val = kpiRow[s];
                const pct = kpiRow.total > 0 ? (val / kpiRow.total * 100).toFixed(1) : "0.0";
                return (
                  <div
                    key={s}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-white text-xs font-semibold"
                    style={{ backgroundColor: SOURCE_COLORS[s] }}
                  >
                    <span>{SOURCE_LABELS[s]}</span>
                    <span className="opacity-90">{val.toFixed(2)} GW</span>
                    <span className="opacity-75">({pct}%)</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Stacked bar chart */}
        <div style={{ height: 320 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
              barSize={rangeDays <= 30 ? 14 : rangeDays <= 90 ? 6 : 3}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: "#6b7280" }}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10, fill: "#6b7280" }}
                tickFormatter={v => `${v}`}
                label={{ value: "GW", angle: -90, position: "insideLeft", fontSize: 10, fill: "#9ca3af", dy: 20 }}
                width={36}
              />
              <Tooltip content={customTooltip} />
              <Legend
                formatter={(v) => <span style={{ fontSize: 11, color: "#374151" }}>{SOURCE_LABELS[v as Source]}</span>}
                wrapperStyle={{ paddingTop: 8 }}
              />
              {SOURCES.map(s => (
                <Bar key={s} dataKey={s} stackId="a" fill={SOURCE_COLORS[s]} name={s} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Recent table */}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left py-1.5 px-1 text-gray-500 font-medium">Date</th>
                {SOURCES.map(s => (
                  <th key={s} className="text-right py-1.5 px-1 font-medium" style={{ color: SOURCE_COLORS[s] }}>
                    {SOURCE_LABELS[s]}
                  </th>
                ))}
                <th className="text-right py-1.5 px-1 text-gray-500 font-medium">Avg Total</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(-10).reverse().map(r => (
                <tr key={r.dateKey} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="py-1.5 px-1 text-gray-700 font-medium">{r.dateLabel}</td>
                  {SOURCES.map(s => (
                    <td key={s} className="py-1.5 px-1 text-right font-mono text-gray-700">
                      {showPct
                        ? (r.total > 0 ? (r[s] / r.total * 100).toFixed(1) + "%" : "—")
                        : r[s].toFixed(2)}
                    </td>
                  ))}
                  <td className="py-1.5 px-1 text-right font-mono font-semibold text-gray-800">
                    {r.total.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 text-[11px] text-gray-500">
          Daily average = mean of all 96 × 15-min interval values from Grid India TimeSeries sheet.
          "Avg Total Demand" is column C (total demand/generation). "Others" = residual category (column K);
          values before mid-2025 show 0.0 as the column did not exist in earlier PSP Excel formats.
        </div>
      </div>

      {/* PLF card */}
      <AvgDailyPLFCard rows={rows} />
    </div>
  );
}
