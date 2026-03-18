"""
Backfill Grid India PSP data for a date range.

Uses a single Playwright session to discover all Excel URLs, then processes
each missing date without redundant browser launches.

Usage:
    cd scripts
    python backfill_grid_india.py --from 2023-01-01
    python backfill_grid_india.py --from 2023-01-01 --to 2026-03-17
"""

import argparse
import csv
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from config import CSV_PATHS
from scrape_grid_india import scrape_grid_india, _collect_all_excel_urls


def dates_in_csv(path: str) -> set:
    """Return set of date objects already present in a CSV."""
    result = set()
    p = Path(path)
    if not p.exists():
        return result
    with open(p, newline="") as f:
        for row in csv.reader(f):
            if not row or row[0].strip().lower().startswith("date"):
                continue
            try:
                d, m, y = row[0].strip().split("/")
                y = int(y)
                if y < 100:
                    y += 2000
                result.add(date(y, int(m), int(d)))
            except Exception:
                pass
    return result


def main():
    parser = argparse.ArgumentParser(description="Backfill Grid India PSP data")
    parser.add_argument("--from", dest="from_date", required=True,
                        help="Start date YYYY-MM-DD (inclusive)")
    parser.add_argument("--to", dest="to_date", default=str(date.today()),
                        help="End date YYYY-MM-DD (inclusive, default: today)")
    args = parser.parse_args()

    start = date.fromisoformat(args.from_date)
    end = date.fromisoformat(args.to_date)

    print(f"[BACKFILL] Date range: {start} → {end}")

    # Single Playwright session — discover all Excel URLs for the range
    print("[BACKFILL] Collecting Excel URLs (single browser session)...")
    url_map = _collect_all_excel_urls(start, end)
    print(f"[BACKFILL] Found {len(url_map)} XLS files available on Grid India")

    if not url_map:
        print("[BACKFILL] No URLs found. Check that Grid India page is reachable.")
        return

    # Determine which dates are already present in the solar-nonsolar CSV
    already_done = dates_in_csv(CSV_PATHS["demand_solar_nonsolar"])
    missing = sorted(d for d in url_map if d not in already_done)
    print(f"[BACKFILL] {len(already_done)} dates already present, {len(missing)} dates to process")

    if not missing:
        print("[BACKFILL] All available dates already backfilled. Nothing to do.")
        return

    errors = []
    for i, d in enumerate(missing, 1):
        print(f"\n[BACKFILL] [{i}/{len(missing)}] {d}")
        try:
            scrape_grid_india(target_date=d, excel_url=url_map[d])
        except SystemExit as e:
            # scrape_grid_india uses sys.exit(2) for "not yet available"
            if e.code == 2:
                print(f"[BACKFILL] Skipping {d} — Excel reported as not available")
            else:
                errors.append(str(d))
        except Exception as e:
            print(f"[BACKFILL] ERROR for {d}: {e}")
            errors.append(str(d))

    print(f"\n[BACKFILL] Done. Processed {len(missing)} dates.")
    if errors:
        print(f"[BACKFILL] {len(errors)} error(s): {', '.join(errors)}")


if __name__ == "__main__":
    main()
