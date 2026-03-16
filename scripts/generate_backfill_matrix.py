"""
Generate a GitHub Actions matrix JSON for parallel IEX backfill.

Usage (called by backfill_iex.yml):
  python generate_backfill_matrix.py \\
      --market rtm \\
      --start-date 2022-04-01 \\
      --end-date   2026-03-15 \\
      --skip-existing        # omit dates already in CSV

Outputs two lines to stdout (consumed by the workflow):
  matrix=<JSON>
  count=<int>

With --skip-existing: only chunks that contain at least one missing date
are included, so already-filled ranges are skipped automatically.
"""

import argparse
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from backfill_iex import _date_chunks, _read_csv, _existing_dates, MAX_CHUNK_DAYS
from config import CSV_PATHS


def _missing_chunks(
    csv_path: str, start: date, end: date
) -> list[tuple[date, date]]:
    """
    Return ≤31-day chunks within [start, end] that contain at least one date
    not yet present in the CSV.
    """
    rows = _read_csv(csv_path)
    existing = _existing_dates(rows)

    all_chunks = _date_chunks(start, end)
    needed = []
    for cs, ce in all_chunks:
        day = cs
        while day <= ce:
            if day not in existing:
                needed.append((cs, ce))
                break
            day += timedelta(days=1)
    return needed


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate backfill matrix JSON")
    parser.add_argument("--market", choices=["rtm", "dam", "both"], default="both")
    parser.add_argument("--start-date", default="2022-04-01")
    parser.add_argument(
        "--end-date",
        default=str(date.today() - timedelta(days=1)),
    )
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="Omit date chunks already present in the CSV",
    )
    parser.add_argument(
        "--force-solar",
        action="store_true",
        help=(
            "RTM only: overwrite solar/nonsolar for ALL dates. "
            "Implies all RTM chunks are included (skip-existing ignored for RTM)."
        ),
    )
    args = parser.parse_args()

    start = datetime.strptime(args.start_date, "%Y-%m-%d").date()
    end   = datetime.strptime(args.end_date,   "%Y-%m-%d").date()

    if start > end:
        print(f"start_date {start} is after end_date {end} — nothing to do",
              file=sys.stderr)
        start = end  # produce sentinel

    markets = ["rtm", "dam"] if args.market == "both" else [args.market]

    matrix_items: list[dict] = []
    for market in markets:
        # force_solar on RTM means we must process ALL chunks regardless of existing data
        force_this = args.force_solar and market == "rtm"

        if args.skip_existing and not force_this:
            chunks = _missing_chunks(CSV_PATHS[market], start, end)
            print(
                f"[{market.upper()}] {len(chunks)} chunks with missing dates "
                f"(out of {len(_date_chunks(start, end))} total)",
                file=sys.stderr,
            )
        else:
            chunks = _date_chunks(start, end)
            reason = "force-solar" if force_this else "no skip"
            print(
                f"[{market.upper()}] {len(chunks)} chunks (all, {reason})",
                file=sys.stderr,
            )

        for chunk_start, chunk_end in chunks:
            matrix_items.append(
                {
                    "market":      market,
                    "start":       str(chunk_start),
                    "end":         str(chunk_end),
                    "force_solar": "true" if force_this else "false",
                }
            )

    real_count = len(matrix_items)
    print(f"Total matrix items: {real_count}", file=sys.stderr)

    # GitHub Actions requires at least one matrix item; use a sentinel if empty
    if not matrix_items:
        matrix_items = [{"market": "none", "start": "skip", "end": "skip", "force_solar": "false"}]

    matrix_json = json.dumps({"include": matrix_items})

    # Write to GitHub Actions output (sourced by the workflow step)
    print(f"matrix={matrix_json}")
    print(f"count={real_count}")


if __name__ == "__main__":
    main()
