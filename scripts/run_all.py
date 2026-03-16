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

    results = [
        run("Grid India PSP Report", scrape_grid_india),
        run("Coal PLF (ICED NITI)", scrape_coal_plf),
    ]
    return all(results)


def mode_capacity() -> bool:
    from scrape_iced_niti import scrape_capacity

    return run("Installed Capacity (ICED NITI)", scrape_capacity)


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
