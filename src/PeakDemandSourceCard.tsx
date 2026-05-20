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

const SOURCES = ["thermal", "solar", "wind", "hydro", "nuclear", "gas", "others"] as const;
type Source = typeof SOURCES[number];

const SOURCE_LABELS: Record<Source, string> = {
  thermal: "Thermal",
  solar:   "Solar",
  wind:    "Wind",
  hydro:   "Hydro",
  nuclear: "Nuclear",
  gas:     "Gas",
  others:  "Others",
};

const SOURCE_COLORS: Record<Source, string> = {
  thermal: "#b45309",
  solar:   "#ca8a04",
  wind:    "#0891b2",
  hydro:   "#0369a1",
  nuclear: "#7c3aed",
  gas:     "#ea580c",
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

const PLF_TO_DS: Record<PLFSource, Source> = {
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

const PLF_CAP_KEY    = "peakDemandPLF_capacity";
const PLF_MAINT_KEY  = "peakDemandPLF_maint";
const DEFAULT_MAINT  = 5;
const MAINT_PRESETS  = [0, 2, 5, 8, 10, 15, 20];

async function fetchLatestCapacity(): Promise<Record<PLFSource, number>> {
  const res = await fetch("/data/capacity.csv");
  if (!res.ok) throw new Error(`capacity.csv HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error("empty capacity.csv");
  const header = lines[0].replace(/^﻿/, "").split(",").map(h => h.trim().toLowerCase());
  const lastRow = lines[lines.length - 1].split(",").map(c => c.trim());
  const col = (name: string) => {
    const idx = header.indexOf(name.toLowerCase());
    return idx >= 0 ? parseFloat(lastRow[idx] ?? "0") || 0 : 0;
  };
  return {
    "Coal":      col("coal"),
    "Oil & Gas": col("oil & gas"),
    "Nuclear":   col("nuclear"),
    "Hydro":     col("hydro") + col("small-hydro"),
    "Solar":     col("solar"),
    "Wind":      col("wind"),
    "Bio Power": col("bio power"),
  };
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface DemandSourceRow {
  dateKey: string;      // YYYY-MM-DD (sortable)
  dateLabel: string;    // DD Mon YY (display)
  rawDate: string;      // original CSV date string
  solar_time: string;
  nonsolar_time: string;
  solar: Record<Source, number>;
  nonsolar: Record<Source, number>;
  // Official peak demand met from Peak Demand Solar-NonSolar.csv
  // Sources sum to Total Generation (includes exports); these are Demand Met
  solar_demand_gw: number | null;
  nonsolar_demand_gw: number | null;
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

/** Parse Peak Demand Solar-NonSolar.csv → {dateKey: {solar_gw, nonsolar_gw}} */
function parsePeakDemandMap(text: string): Map<string, { solar: number; nonsolar: number }> {
  const map = new Map<string, { solar: number; nonsolar: number }>();
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return map;
  const header = lines[0].split(",").map(h => h.trim());
  const solarIdx    = header.indexOf("solar_gw");
  const nonsolarIdx = header.indexOf("nonsolar_gw");
  if (solarIdx < 0 || nonsolarIdx < 0) return map;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(c => c.trim());
    const dateKey = parseDateKey(cols[0] ?? "");
    if (!dateKey) continue;
    const solar    = parseFloat(cols[solarIdx]    ?? "") || 0;
    const nonsolar = parseFloat(cols[nonsolarIdx] ?? "") || 0;
    // keep last row per date (deduplicates any stale duplicates in the CSV)
    map.set(dateKey, { solar, nonsolar });
  }
  return map;
}

function parseCsv(
  text: string,
  peakMap: Map<string, { solar: number; nonsolar: number }>,
): DemandSourceRow[] {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map(h => h.trim());
  const rows: DemandSourceRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(c => c.trim());
    if (cols.length < 17) continue;
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => { obj[h] = cols[idx] ?? ""; });

    const rawDate = obj["date"] ?? "";
    const dateKey = parseDateKey(rawDate);
    if (!dateKey) continue;

    const num = (k: string) => parseFloat(obj[k] ?? "0") || 0;
    const peak = peakMap.get(dateKey);

    rows.push({
      dateKey,
      dateLabel: fmtDateLabel(dateKey),
      rawDate,
      solar_time:    obj["solar_time"]    ?? "",
      nonsolar_time: obj["nonsolar_time"] ?? "",
      solar: {
        nuclear: num("solar_nuclear_gw"),
        wind:    num("solar_wind_gw"),
        solar:   num("solar_solar_gw"),
        hydro:   num("solar_hydro_gw"),
        gas:     num("solar_gas_gw"),
        thermal: num("solar_thermal_gw"),
        others:  num("solar_others_gw"),
      },
      nonsolar: {
        nuclear: num("nonsolar_nuclear_gw"),
        wind:    num("nonsolar_wind_gw"),
        solar:   num("nonsolar_solar_gw"),
        hydro:   num("nonsolar_hydro_gw"),
        gas:     num("nonsolar_gas_gw"),
        thermal: num("nonsolar_thermal_gw"),
        others:  num("nonsolar_others_gw"),
      },
      solar_demand_gw:    peak?.solar    ?? null,
      nonsolar_demand_gw: peak?.nonsolar ?? null,
    });
  }

  return rows.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface PanelProps {
  title: string;
  subtitle: string;
  rows: DemandSourceRow[];
  period: "solar" | "nonsolar";
  rangeDays: number;
  spotlightDateKey: string | null;
}

function SourcePanel({ title, subtitle, rows, period, rangeDays, spotlightDateKey }: PanelProps) {
  const filtered = useMemo(() => {
    if (rangeDays === 0) return rows;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - rangeDays);
    const cutoffKey = cutoff.toISOString().slice(0, 10);
    return rows.filter(r => r.dateKey >= cutoffKey);
  }, [rows, rangeDays]);

  const latest = filtered[filtered.length - 1];

  // KPI row: spotlight date if selected, otherwise latest in range
  const kpiRow = useMemo(() => {
    if (!spotlightDateKey) return latest;
    return rows.find(r => r.dateKey === spotlightDateKey) ?? latest;
  }, [spotlightDateKey, rows, latest]);

  const chartData = filtered.map(r => ({
    label: fmtXLabel(r.dateKey),
    dateKey: r.dateKey,
    time: period === "solar" ? r.solar_time : r.nonsolar_time,
    ...Object.fromEntries(
      SOURCES.map(s => [s, r[period][s]])
    ),
  }));

  // Official peak demand met (from Peak Demand Solar-NonSolar.csv)
  // Sources sum to Total Generation which includes net exports → slightly > Demand Met
  const officialLatest = kpiRow
    ? (period === "solar" ? kpiRow.solar_demand_gw : kpiRow.nonsolar_demand_gw)
    : null;
  const genLatest = kpiRow
    ? SOURCES.reduce((sum, s) => sum + (kpiRow[period][s] ?? 0), 0)
    : 0;
  // Use official demand met for display; fall back to generation sum if unavailable
  const totalLatest = officialLatest ?? genLatest;

  const customTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    const genTotal = payload.reduce((s: number, p: any) => s + (p.value ?? 0), 0);
    // Find the row for this bar to get official demand
    const row = filtered.find(r => fmtXLabel(r.dateKey) === label);
    const official = row ? (period === "solar" ? row.solar_demand_gw : row.nonsolar_demand_gw) : null;
    return (
      <div className="bg-white border border-gray-200 rounded shadow-lg p-3 text-xs">
        <div className="font-semibold text-gray-700 mb-1">{label}</div>
        {payload.slice().reverse().map((p: any) => (
          <div key={p.dataKey} className="flex justify-between gap-4">
            <span style={{ color: p.color }}>{SOURCE_LABELS[p.dataKey as Source]}</span>
            <span className="font-mono">{p.value?.toFixed(2)} GW</span>
          </div>
        ))}
        <div className="border-t border-gray-200 mt-1 pt-1 space-y-0.5">
          <div className="flex justify-between font-semibold">
            <span>Demand Met</span>
            <span className="font-mono">{official != null ? official.toFixed(2) : "—"} GW</span>
          </div>
          {official != null && (
            <div className="flex justify-between text-gray-400">
              <span>Incl. exports</span>
              <span className="font-mono">{genTotal.toFixed(2)} GW</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex-1 min-w-0">
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <div className="mb-1">
          <h3 className="text-base font-bold text-gray-800">{title}</h3>
          <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>
        </div>

        {/* KPI badges — shows spotlight date if selected, otherwise latest in range */}
        {kpiRow && (
          <div className="mb-4 mt-3">
            <div className="text-xs text-gray-500 mb-2 font-medium uppercase tracking-wide flex items-center gap-2">
              <span>
                {kpiRow.dateLabel} — Peak @ {period === "solar" ? kpiRow.solar_time : kpiRow.nonsolar_time}
                {" "}· Demand Met {totalLatest.toFixed(2)} GW
              </span>
              {spotlightDateKey && kpiRow.dateKey !== latest?.dateKey && (
                <span className="text-blue-500 font-semibold normal-case">· selected</span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {SOURCES.map(s => {
                const val = kpiRow[period][s];
                const pct = totalLatest > 0 ? (val / totalLatest * 100).toFixed(1) : "0.0";
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
        <div style={{ height: 300 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }} barSize={rangeDays <= 30 ? 14 : rangeDays <= 90 ? 6 : 3}>
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
                <th className="text-right py-1.5 px-1 text-gray-500 font-medium">Time</th>
                {SOURCES.map(s => (
                  <th key={s} className="text-right py-1.5 px-1 font-medium" style={{ color: SOURCE_COLORS[s] }}>
                    {SOURCE_LABELS[s]}
                  </th>
                ))}
                <th className="text-right py-1.5 px-1 text-gray-500 font-medium">Demand Met</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(-10).reverse().map(r => {
                const official = period === "solar" ? r.solar_demand_gw : r.nonsolar_demand_gw;
                const fallback = SOURCES.reduce((s, src) => s + (r[period][src] ?? 0), 0);
                return (
                  <tr key={r.dateKey} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="py-1.5 px-1 text-gray-700 font-medium">{r.dateLabel}</td>
                    <td className="py-1.5 px-1 text-right text-gray-500 font-mono">
                      {period === "solar" ? r.solar_time : r.nonsolar_time}
                    </td>
                    {SOURCES.map(s => (
                      <td key={s} className="py-1.5 px-1 text-right font-mono text-gray-700">
                        {r[period][s].toFixed(2)}
                      </td>
                    ))}
                    <td className="py-1.5 px-1 text-right font-mono font-semibold text-gray-800">
                      {(official ?? fallback).toFixed(2)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── PLF Card ──────────────────────────────────────────────────────────────────

function PeakDemandPLFCard({ latestRow }: { latestRow: DemandSourceRow | null }) {
  const [capacity, setCapacity] = useState<Record<PLFSource, number>>(() => {
    try {
      const raw = localStorage.getItem(PLF_CAP_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        const out = Object.fromEntries(PLF_SOURCES.map(s => [s, 0])) as Record<PLFSource, number>;
        for (const s of PLF_SOURCES) out[s] = Number(obj[s]) || 0;
        if (PLF_SOURCES.some(s => out[s] !== 0)) return out;
      }
    } catch {}
    return Object.fromEntries(PLF_SOURCES.map(s => [s, 0])) as Record<PLFSource, number>;
  });

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

  const loadFromCsv = useCallback(async () => {
    try {
      const vals = await fetchLatestCapacity();
      setCapacity(vals);
    } catch {}
  }, []);

  useEffect(() => {
    const allZero = PLF_SOURCES.every(s => capacity[s] === 0);
    if (allZero) loadFromCsv();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try { localStorage.setItem(PLF_CAP_KEY, JSON.stringify(capacity)); } catch {}
  }, [capacity]);

  useEffect(() => {
    try { localStorage.setItem(PLF_MAINT_KEY, JSON.stringify(maint)); } catch {}
  }, [maint]);

  const availCap = useMemo(() => {
    const out = {} as Record<PLFSource, number>;
    for (const s of PLF_SOURCES) out[s] = capacity[s] * (1 - maint[s] / 100);
    return out;
  }, [capacity, maint]);

  const capTotal  = PLF_SOURCES.reduce((sum, s) => sum + (capacity[s] || 0), 0);
  const availTotal = PLF_SOURCES.reduce((sum, s) => sum + availCap[s], 0);

  const solarGW = useMemo(() => {
    const out = {} as Record<PLFSource, number>;
    for (const s of PLF_SOURCES) out[s] = latestRow?.solar[PLF_TO_DS[s]] ?? 0;
    return out;
  }, [latestRow]);

  const nonsolarGW = useMemo(() => {
    const out = {} as Record<PLFSource, number>;
    for (const s of PLF_SOURCES) out[s] = latestRow?.nonsolar[PLF_TO_DS[s]] ?? 0;
    return out;
  }, [latestRow]);

  const solarPLF = useMemo(() => {
    const out = {} as Record<PLFSource, number | null>;
    for (const s of PLF_SOURCES) out[s] = availCap[s] > 0 ? (solarGW[s] / availCap[s]) * 100 : null;
    return out;
  }, [solarGW, availCap]);

  const nonsolarPLF = useMemo(() => {
    const out = {} as Record<PLFSource, number | null>;
    for (const s of PLF_SOURCES) out[s] = availCap[s] > 0 ? (nonsolarGW[s] / availCap[s]) * 100 : null;
    return out;
  }, [nonsolarGW, availCap]);

  const solarDemand    = latestRow?.solar_demand_gw    ?? null;
  const nonsolarDemand = latestRow?.nonsolar_demand_gw ?? null;
  const solarPLFTotal    = solarDemand    != null && availTotal > 0 ? (solarDemand    / availTotal) * 100 : null;
  const nonsolarPLFTotal = nonsolarDemand != null && availTotal > 0 ? (nonsolarDemand / availTotal) * 100 : null;

  const inputCls = "w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-right text-sm text-slate-900 outline-none focus:ring-2 focus:ring-slate-300 tabular-nums";
  const latestDateLabel = latestRow?.dateLabel ?? "—";

  const fmtPLF = (v: number | null) => v === null ? "—" : `${v.toFixed(1)}%`;

  return (
    <div className="mt-6 bg-white rounded-2xl shadow-sm ring-1 ring-slate-200">
      <div className="flex items-center justify-between border-b border-slate-100 p-4">
        <div>
          <div className="text-sm font-semibold text-slate-800">Peak Demand PLF</div>
          <div className="text-xs text-slate-500 mt-0.5">
            Plant Load Factor at daily peak demand timestamp · {latestDateLabel}
          </div>
        </div>
        <button
          onClick={loadFromCsv}
          className="text-xs text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg px-2 py-1 bg-white hover:bg-slate-50"
        >
          Reset to CSV defaults
        </button>
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

              {/* Row 3a: Solar Hours GW */}
              <tr className="border-t border-slate-100 bg-amber-50/40">
                <td className="px-3 py-2 font-semibold text-slate-800 text-xs">
                  GW at Peak — Solar Hours
                  <div className="text-[10px] font-normal text-slate-500 mt-0.5">
                    {latestDateLabel} · {latestRow?.solar_time ?? "—"}
                  </div>
                </td>
                {PLF_SOURCES.map(s => (
                  <td key={s} className="px-3 py-2 text-right font-mono text-sm text-slate-900 tabular-nums">
                    {(solarGW[s] ?? 0).toFixed(2)}
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900 text-sm">
                  {solarDemand != null ? solarDemand.toFixed(2) : "—"}
                </td>
              </tr>

              {/* Row 3b: Non-Solar Hours GW */}
              <tr className="border-t border-slate-100 bg-indigo-50/40">
                <td className="px-3 py-2 font-semibold text-slate-800 text-xs">
                  GW at Peak — Non-Solar Hours
                  <div className="text-[10px] font-normal text-slate-500 mt-0.5">
                    {latestDateLabel} · {latestRow?.nonsolar_time ?? "—"}
                  </div>
                </td>
                {PLF_SOURCES.map(s => (
                  <td key={s} className="px-3 py-2 text-right font-mono text-sm text-slate-900 tabular-nums">
                    {(nonsolarGW[s] ?? 0).toFixed(2)}
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900 text-sm">
                  {nonsolarDemand != null ? nonsolarDemand.toFixed(2) : "—"}
                </td>
              </tr>

              {/* Row 4a: Solar PLF */}
              <tr className="border-t border-slate-100 bg-amber-50/70">
                <td className="px-3 py-2 font-bold text-slate-900 text-xs">PLF % — Solar Hours</td>
                {PLF_SOURCES.map(s => (
                  <td key={s} className="px-3 py-2 text-right font-semibold tabular-nums text-sm text-slate-900">
                    {fmtPLF(solarPLF[s])}
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-bold tabular-nums text-slate-900 text-sm">
                  {fmtPLF(solarPLFTotal)}
                </td>
              </tr>

              {/* Row 4b: Non-Solar PLF */}
              <tr className="border-t border-slate-100 bg-indigo-50/70">
                <td className="px-3 py-2 font-bold text-slate-900 text-xs">PLF % — Non-Solar Hours</td>
                {PLF_SOURCES.map(s => (
                  <td key={s} className="px-3 py-2 text-right font-semibold tabular-nums text-sm text-slate-900">
                    {fmtPLF(nonsolarPLF[s])}
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-bold tabular-nums text-slate-900 text-sm">
                  {fmtPLF(nonsolarPLFTotal)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="mt-3 space-y-0.5 text-[11px] text-slate-500">
          <div>PLF% = GW at Peak ÷ (Installed Capacity × (1 − Maintenance%/100)) × 100. Capacity and maintenance values are editable and saved in your browser.</div>
          <div>* Hydro column combines Hydro and Small-Hydro installed capacity from capacity.csv; GW = combined hydro output from Grid India TimeSeries.</div>
          <div>† Others/Bio Power column = residual "Others" category from Grid India TimeSeries, which includes Bio Power and other minor sources.</div>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PeakDemandSourceCard() {
  const [rows, setRows] = useState<DemandSourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rangeDays, setRangeDays] = useState<number>(30);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/data/demand_source.csv").then(r => { if (!r.ok) throw new Error(`demand_source HTTP ${r.status}`); return r.text(); }),
      fetch("/data/Peak Demand Solar-NonSolar.csv").then(r => { if (!r.ok) throw new Error(`peak demand HTTP ${r.status}`); return r.text(); }),
    ])
      .then(([srcText, peakText]) => {
        const peakMap = parsePeakDemandMap(peakText);
        setRows(parseCsv(srcText, peakMap));
        setLoading(false);
      })
      .catch(e => {
        setError(e.message);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
        Loading demand source data…
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
          <h2 className="text-lg font-bold text-gray-800">Peak Demand — Source Breakdown</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            MW source mix at the daily peak demand timestamp · Solar &amp; Non-Solar hours · converted to GW
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Range buttons */}
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

          {/* Date picker */}
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

      {/* Two panels side by side */}
      <div className="flex flex-col lg:flex-row gap-4">
        <SourcePanel
          title="Solar Hours Peak"
          subtitle="Source mix at the peak demand timestamp during daytime (solar hours)"
          rows={rows}
          period="solar"
          rangeDays={rangeDays}
          spotlightDateKey={selectedDate}
        />
        <SourcePanel
          title="Non-Solar Hours Peak"
          subtitle="Source mix at the peak demand timestamp during evening/night (non-solar hours)"
          rows={rows}
          period="nonsolar"
          rangeDays={rangeDays}
          spotlightDateKey={selectedDate}
        />
      </div>

      {/* PLF card — latest date's source GW vs available capacity */}
      <PeakDemandPLFCard latestRow={rows.length > 0 ? rows[rows.length - 1] : null} />
    </div>
  );
}
