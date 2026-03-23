"""
One-time backfill: extract statewise demand from Grid India PSP Excel files
for a date range and write to statewise_demand.csv.

Usage:
  python backfill_statewise_demand.py                      # Jan 1 2021 → yesterday
  python backfill_statewise_demand.py --start 2021-01-01 --end 2026-03-22
  python backfill_statewise_demand.py --test              # test on 5 recent dates

Run from the scripts/ directory:
  cd scripts && python backfill_statewise_demand.py

The script is idempotent — it skips dates already in the CSV.
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
    _find_excel_url,
    _open_sheet,
    _extract_statewise,
    _append_statewise_csv,
    _format_date,
    HEADERS,
    IST,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _dates_already_in_csv(path: str) -> set:
    """Return set of date strings already present in the statewise CSV."""
    p = Path(path)
    if not p.exists():
        return set()
    with open(p, newline="") as f:
        reader = csv.reader(f)
        next(reader, None)  # skip header
        return {row[0].strip() for row in reader if row}


def _download_excel(url: str) -> Optional[bytes]:
    try:
        r = requests.get(url, headers=HEADERS, timeout=60)
        r.raise_for_status()
        return r.content
    except Exception as e:
        print(f"  [DL] Failed: {e}")
        return None


# ── Main ──────────────────────────────────────────────────────────────────────

def backfill(start: date, end: date, test_mode: bool = False) -> None:
    csv_path = CSV_PATHS["statewise_demand"]
    already_done = _dates_already_in_csv(csv_path)
    print(f"[BACKFILL] {len(already_done)} dates already in CSV.")

    # Build list of dates to fetch
    all_dates = []
    d = start
    while d <= end:
        date_str = _format_date(d)
        if date_str not in already_done:
            all_dates.append(d)
        d += timedelta(days=1)

    if test_mode:
        # Use 5 most recent dates for quick validation
        all_dates = all_dates[-5:] if len(all_dates) >= 5 else all_dates
        print(f"[BACKFILL] TEST MODE — processing {len(all_dates)} dates: {all_dates}")
    else:
        print(f"[BACKFILL] {len(all_dates)} dates to fetch ({start} → {end}).")

    if not all_dates:
        print("[BACKFILL] Nothing to do.")
        return

    # Bulk-collect URLs via Grid India API (much faster than per-file requests)
    print(f"\n[BACKFILL] Collecting Excel URLs via Grid India API...")
    url_map = _collect_all_excel_urls(all_dates[0], all_dates[-1])
    print(f"[BACKFILL] API returned {len(url_map)} URLs.\n")

    success = 0
    skipped = 0
    failed  = 0

    for i, target in enumerate(all_dates, 1):
        date_str = _format_date(target)

        # Progress update every 50 dates
        if i % 50 == 1 or i == len(all_dates):
            print(f"[BACKFILL] Progress: {i}/{len(all_dates)} — target={target}")

        # Get URL from bulk API map only — no per-file CDN fallback.
        # If the API batch returned 0 files for a given FY-month, the files
        # don't exist on the CDN either, so avoid slow per-date probes.
        url = url_map.get(target)
        if url is None:
            skipped += 1
            if i % 50 == 1:
                print(f"  [{target}] Not in API results — skipping.")
            continue

        # Download
        excel_bytes = _download_excel(url)
        if excel_bytes is None:
            failed += 1
            continue

        # Open sheet
        ws = _open_sheet(excel_bytes, "MOP_E")
        if ws is None:
            print(f"  [{target}] Could not open MOP_E sheet — skipping.")
            failed += 1
            continue

        # Extract statewise data
        states = _extract_statewise(ws)
        if not states:
            print(f"  [{target}] No statewise data — skipping.")
            skipped += 1
            continue

        # Append to CSV
        _append_statewise_csv(csv_path, date_str, states)
        success += 1

        # Polite delay
        time.sleep(0.3)

    print(f"\n[BACKFILL] Done. Success={success}, Skipped={skipped}, Failed={failed}")
    print(f"[BACKFILL] Output: {csv_path}")

    # Quick summary of CSV state
    done = _dates_already_in_csv(csv_path)
    print(f"[BACKFILL] Total rows in CSV: {len(done)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill statewise demand from Grid India PSP files")
    parser.add_argument("--start", default="2021-01-01", help="Start date YYYY-MM-DD")
    parser.add_argument("--end",   default=None,         help="End date YYYY-MM-DD (default: yesterday IST)")
    parser.add_argument("--test",  action="store_true",  help="Test mode: only process last 5 dates")
    args = parser.parse_args()

    start_date = date.fromisoformat(args.start)
    if args.end:
        end_date = date.fromisoformat(args.end)
    else:
        end_date = datetime.now(IST).date() - timedelta(days=1)

    backfill(start_date, end_date, test_mode=args.test)
