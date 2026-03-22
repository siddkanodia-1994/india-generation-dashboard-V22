"""
Orchestrator: run all scrapers for a given mode.

Usage:
  python run_all.py --mode prices       # RTM + DAM + Stocks
  python run_all.py --mode generation   # Grid India PSP + Coal PLF
  python run_all.py --mode capacity     # ICED NITI capacity (monthly)
  python run_all.py --mode all          # Everything
"""

import argparse
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))


def run(name: str, fn) -> bool:
    print(f"\n{'='*50}")
    print(f"Running: {name}")
    print("=" * 50)
    try:
        result = fn()
        if result:
            print(f"✓ {name} succeeded.")
        else:
            print(f"✗ {name} FAILED.")
        return result
    except SystemExit as e:
        code = e.code
        if code == 2:
            print(f"⏳ {name}: data not yet available (exit 2 — retry later).")
            raise  # Propagate so GitHub Actions knows to retry
        print(f"✗ {name} exited with code {code}.")
        return False
    except Exception:
        print(f"✗ {name} raised an exception:")
        traceback.print_exc()
        return False


def mode_prices() -> bool:
    from scrape_iex_rtm import scrape_rtm
    from scrape_iex_dam import scrape_dam
    from scrape_stocks import scrape_stocks

    results = [
        run("IEX RTM Prices", scrape_rtm),
        run("IEX DAM Prices", scrape_dam),
        run("Stock Prices (Screener.in)", scrape_stocks),
    ]
    return all(results)


def mode_generation() -> bool:
    from scrape_grid_india import scrape_grid_india
    from scrape_iced_niti import scrape_coal_plf
    from config import CSV_PATHS
    from datetime import date, datetime, timedelta, timezone
    from pathlib import Path
    import csv as _csv

    def _last_date(path):
        p = Path(path)
        if not p.exists():
            return None
        with open(p, newline="") as f:
            rows = [r for r in _csv.reader(f) if r and not r[0].strip().lower().startswith("date")]
        if not rows:
            return None
        try:
            d, m, y = rows[-1][0].strip().split("/")
            y = int(y)
            if y < 100:
                y += 2000
            return date(y, int(m), int(d))
        except Exception:
            return None

    ist_now = datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)
    yesterday = ist_now.date() - timedelta(days=1)

    # Build list of missing dates to fetch (up to 7 days back)
    last = _last_date(CSV_PATHS["supply"])
    start = (last + timedelta(days=1)) if last else yesterday
    dates_to_fetch = []
    d = start
    while d <= yesterday and len(dates_to_fetch) < 7:
        dates_to_fetch.append(d)
        d += timedelta(days=1)

    grid_ok = True
    for target in dates_to_fetch:
        print(f"\n{'='*50}")
        print(f"Running: Grid India PSP Report ({target})")
        print("=" * 50)
        try:
            ok = scrape_grid_india(target)
            if ok:
                print(f"✓ Grid India PSP Report ({target}) succeeded.")
            else:
                print(f"✗ Grid India PSP Report ({target}) FAILED.")
                grid_ok = False
                break
        except SystemExit as e:
            if e.code == 2:
                print(f"⏳ Grid India PSP Report ({target}): data not yet available — retry tomorrow.")
                raise  # Propagate exit 2 so GitHub Actions retries
            print(f"✗ Grid India PSP Report ({target}) exited with code {e.code}.")
            grid_ok = False
            break
        except Exception:
            import traceback as _tb
            print(f"✗ Grid India PSP Report ({target}) raised an exception:")
            _tb.print_exc()
            grid_ok = False
            break

    plf_ok = run("Coal PLF (ICED NITI)", scrape_coal_plf)
    return grid_ok and plf_ok


def mode_capacity() -> bool:
    from scrape_iced_niti import scrape_capacity
    from config import CSV_PATHS
    from scrape_iced_niti import _last_date_in_csv
    from datetime import date, timedelta

    csv_path = CSV_PATHS["capacity"]
    last = _last_date_in_csv(csv_path)
    today = date.today()
    current_month = today.replace(day=1)
    start_month = (last.replace(day=1) + timedelta(days=32)).replace(day=1) if last else current_month

    # Backfill any missing months up to current month
    success = True
    m = start_month
    while m <= current_month:
        ok = run(f"Installed Capacity (ICED NITI) {m.strftime('%B %Y')}", lambda mo=m: scrape_capacity(mo))
        if not ok:
            print(f"[NITI-CAP] No data for {m.strftime('%B %Y')} yet — skipping remaining months.")
            break
        m = (m + timedelta(days=32)).replace(day=1)
    return success


def mode_all() -> bool:
    ok_prices = mode_prices()
    ok_gen    = mode_generation()
    ok_cap    = mode_capacity()
    return ok_prices and ok_gen and ok_cap


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run India Power Dashboard scrapers")
    parser.add_argument(
        "--mode",
        choices=["prices", "generation", "capacity", "all"],
        required=True,
        help="Which set of scrapers to run",
    )
    args = parser.parse_args()

    mode_fn = {
        "prices":     mode_prices,
        "generation": mode_generation,
        "capacity":   mode_capacity,
        "all":        mode_all,
    }[args.mode]

    success = mode_fn()

    print("\n" + ("=" * 50))
    print(f"Overall result: {'SUCCESS' if success else 'FAILURE'}")
    print("=" * 50)

    sys.exit(0 if success else 1)
