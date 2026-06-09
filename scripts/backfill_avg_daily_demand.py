"""
Backfill average_daily_demand.csv from Grid India PSP Excel files.

Computes daily averages across all 96 × 15-min TimeSeries rows per source.

Usage:
  python backfill_avg_daily_demand.py              # all missing dates
  python backfill_avg_daily_demand.py --test       # last 5 dates only
  python backfill_avg_daily_demand.py --start 2025-01-01
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
    _compute_daily_averages,
    _write_avg_daily_demand_csv,
    HEADERS,
    IST,
)


def _dates_in_peak_csv(csv_path: str) -> list:
    """Return list of date strings from Peak Demand Solar-NonSolar.csv."""
    p = Path(csv_path)
    if not p.exists():
        return []
    out = []
    with open(p, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            d = row.get("date", "").strip()
            if d:
                out.append(d)
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
    sn_path  = CSV_PATHS["demand_solar_nonsolar"]
    avg_path = CSV_PATHS["avg_daily_demand"]

    all_dates = _dates_in_peak_csv(sn_path)
    print(f"[BACKFILL-AVG] {len(all_dates)} dates in Peak Demand Solar-NonSolar.csv.")

    already_done = _dates_already_in_csv(avg_path)
    print(f"[BACKFILL-AVG] {len(already_done)} dates already in average_daily_demand.csv.")

    candidates = []
    for date_str in all_dates:
        if date_str in already_done:
            continue
        d = _parse_date_str(date_str)
        if d is None:
            continue
        if start and d < start:
            continue
        if end and d > end:
            continue
        candidates.append((d, date_str))

    candidates.sort(key=lambda x: x[0])

    if not candidates:
        print("[BACKFILL-AVG] Nothing to do.")
        return

    if test_mode:
        candidates = candidates[-5:]
        print(f"[BACKFILL-AVG] TEST MODE — {len(candidates)} dates: {[c[0] for c in candidates]}")
    else:
        print(f"[BACKFILL-AVG] {len(candidates)} dates to process.")

    start_d = candidates[0][0]
    end_d   = candidates[-1][0]
    print(f"\n[BACKFILL-AVG] Collecting Excel URLs via API ({start_d} → {end_d})...")
    url_map = _collect_all_excel_urls(start_d, end_d)
    print(f"[BACKFILL-AVG] API returned {len(url_map)} URLs.\n")

    success = skipped = failed = 0

    for i, (target, date_str) in enumerate(candidates, 1):
        if i % 50 == 1 or i == len(candidates):
            print(f"[BACKFILL-AVG] Progress: {i}/{len(candidates)} — {target}")

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
            print(f"  [{target}] No TimeSeries sheet — skipping.")
            skipped += 1
            continue

        avg_data = _compute_daily_averages(ts_ws, target)
        if not avg_data:
            print(f"  [{target}] Empty TimeSeries data — skipping.")
            failed += 1
            continue

        ok = _write_avg_daily_demand_csv(target, avg_data)
        if ok:
            success += 1
        else:
            failed += 1

        time.sleep(0.3)

    print(f"\n[BACKFILL-AVG] Done. Success={success}, Skipped={skipped}, Failed={failed}")
    print(f"[BACKFILL-AVG] Output: {avg_path}")
    done = _dates_already_in_csv(avg_path)
    print(f"[BACKFILL-AVG] Total rows in average_daily_demand.csv: {len(done)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill average_daily_demand.csv")
    parser.add_argument("--start", default=None, help="Start date YYYY-MM-DD")
    parser.add_argument("--end",   default=None, help="End date YYYY-MM-DD")
    parser.add_argument("--test",  action="store_true", help="Test mode: last 5 dates only")
    args = parser.parse_args()

    start_date = date.fromisoformat(args.start) if args.start else None
    end_date   = date.fromisoformat(args.end)   if args.end   else None

    backfill(start_date, end_date, test_mode=args.test)
