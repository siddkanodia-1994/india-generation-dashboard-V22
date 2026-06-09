"""
Backfill demand_source.csv from Grid India PSP Excel files.

Reads solar_time/nonsolar_time from Peak Demand Solar-NonSolar.csv (already scraped),
downloads each day's Excel, parses the TimeSeries sheet, and writes GW source values.

Usage:
  python backfill_demand_source.py              # all missing dates
  python backfill_demand_source.py --test       # last 5 dates only (validation)
  python backfill_demand_source.py --start 2025-01-01
"""

import argparse
import csv
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import requests

sys.path.insert(0, str(Path(__file__).parent))
from config import CSV_PATHS
from scrape_grid_india import (
    _collect_all_excel_urls,
    _open_sheet,
    _format_date,
    _parse_time_series,
    _write_demand_source_csv,
    HEADERS,
    IST,
)


def _load_peak_times(csv_path: str) -> dict:
    """
    Read Peak Demand Solar-NonSolar.csv.
    Returns {date_str: (solar_time, nonsolar_time)} for all rows.
    Deduplicates by keeping the last row per date (in case of duplicates).
    """
    p = Path(csv_path)
    if not p.exists():
        return {}
    out = {}
    with open(p, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            d = row.get("date", "").strip()
            solar_t    = row.get("solar_time", "").strip()
            nonsolar_t = row.get("nonsolar_time", "").strip()
            if d and (solar_t or nonsolar_t):
                out[d] = (solar_t, nonsolar_t)
    return out


def _dates_already_in_csv(path: str) -> set:
    p = Path(path)
    if not p.exists():
        return set()
    with open(p, newline="") as f:
        reader = csv.reader(f)
        next(reader, None)  # skip header
        return {row[0].strip() for row in reader if row}


def _parse_date_str(date_str: str) -> Optional[date]:
    """Parse DD/MM/YY → date object."""
    try:
        parts = date_str.split("/")
        d, m, y = int(parts[0]), int(parts[1]), int(parts[2])
        if y < 100:
            y += 2000
        return date(y, m, d)
    except Exception:
        return None


def _download_excel(url: str) -> Optional[bytes]:
    try:
        r = requests.get(url, headers=HEADERS, timeout=60)
        r.raise_for_status()
        return r.content
    except Exception as e:
        print(f"  [DL] Failed: {e}")
        return None


def backfill(start: Optional[date], end: Optional[date], test_mode: bool = False) -> None:
    sn_path = CSV_PATHS["demand_solar_nonsolar"]
    ds_path = CSV_PATHS["demand_source"]

    peak_times = _load_peak_times(sn_path)
    print(f"[BACKFILL-SRC] {len(peak_times)} dates in Peak Demand Solar-NonSolar.csv.")

    already_done = _dates_already_in_csv(ds_path)
    print(f"[BACKFILL-SRC] {len(already_done)} dates already in demand_source.csv.")

    # Build chronologically-ordered list to process
    candidates = []
    for date_str, (solar_t, nonsolar_t) in peak_times.items():
        if date_str in already_done:
            continue
        d = _parse_date_str(date_str)
        if d is None:
            continue
        if start and d < start:
            continue
        if end and d > end:
            continue
        candidates.append((d, date_str, solar_t, nonsolar_t))

    candidates.sort(key=lambda x: x[0])  # chronological order

    if not candidates:
        print("[BACKFILL-SRC] Nothing to do.")
        return

    if test_mode:
        candidates = candidates[-5:]
        print(f"[BACKFILL-SRC] TEST MODE — {len(candidates)} dates: {[c[0] for c in candidates]}")
    else:
        print(f"[BACKFILL-SRC] {len(candidates)} dates to process.")

    # Bulk URL collection
    start_d = candidates[0][0]
    end_d   = candidates[-1][0]
    print(f"\n[BACKFILL-SRC] Collecting Excel URLs via API ({start_d} → {end_d})...")
    url_map = _collect_all_excel_urls(start_d, end_d)
    print(f"[BACKFILL-SRC] API returned {len(url_map)} URLs.\n")

    success = skipped = failed = 0

    for i, (target, date_str, solar_t, nonsolar_t) in enumerate(candidates, 1):
        if i % 50 == 1 or i == len(candidates):
            print(f"[BACKFILL-SRC] Progress: {i}/{len(candidates)} — {target}")

        url = url_map.get(target)
        if url is None:
            skipped += 1
            continue

        excel_bytes = _download_excel(url)
        if excel_bytes is None:
            failed += 1
            continue

        ts_ws = _open_sheet(excel_bytes, "TimeSeries")
        if ts_ws is None:
            print(f"  [{target}] Could not open TimeSeries sheet — skipping.")
            failed += 1
            continue

        ts_data = _parse_time_series(ts_ws, target)
        ok = _write_demand_source_csv(target, solar_t, nonsolar_t, ts_data)
        if ok:
            success += 1
        else:
            failed += 1

        time.sleep(0.3)

    print(f"\n[BACKFILL-SRC] Done. Success={success}, Skipped={skipped}, Failed={failed}")
    print(f"[BACKFILL-SRC] Output: {ds_path}")
    done = _dates_already_in_csv(ds_path)
    print(f"[BACKFILL-SRC] Total rows in demand_source.csv: {len(done)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill demand_source.csv")
    parser.add_argument("--start", default=None, help="Start date YYYY-MM-DD")
    parser.add_argument("--end",   default=None, help="End date YYYY-MM-DD")
    parser.add_argument("--test",  action="store_true", help="Test mode: last 5 dates only")
    args = parser.parse_args()

    start_date = date.fromisoformat(args.start) if args.start else None
    end_date   = date.fromisoformat(args.end)   if args.end   else None

    backfill(start_date, end_date, test_mode=args.test)
