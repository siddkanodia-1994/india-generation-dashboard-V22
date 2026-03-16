"""
Scrape IEX Real-Time Market (RTM) data via Playwright UI simulation.

Usage:
  python scrape_iex_rtm.py                   # yesterday's finalized data (nightly cron)
  python scrape_iex_rtm.py --period today    # today's live partial data (hourly cron)

Columns written to RTM Prices.csv:
  Date, RTM price (daily avg MCP Rs/Unit), Solar_Avg, NonSolar_Avg

Strategy:
  - Navigate to IEX RTM page (wait for networkidle + extra time for React hydration)
  - Click "Daily" interval tab → select delivery period → parse HTML table → MCP ÷ 1000
  - Click "Hourly" interval tab → same → Solar avg hours 7-18, NonSolar hours 1-6+19-24
  - For "Today": upsert today's row; for "Yesterday": append if not present
"""

import argparse
import csv
import sys
from datetime import date, timedelta
from pathlib import Path
from statistics import mean

sys.path.insert(0, str(Path(__file__).parent))
from config import CSV_PATHS

IEX_RTM_URL = "https://www.iexindia.com/market-data/real-time-market/market-snapshot"

SOLAR_HOURS    = set(range(7, 19))
NONSOLAR_HOURS = set(range(1, 7)) | set(range(19, 25))


# ── CSV helpers ───────────────────────────────────────────────────────────────

def _read_csv(path: str) -> list[list[str]]:
    p = Path(path)
    if not p.exists():
        return []
    with open(p, newline="") as f:
        return list(csv.reader(f))


def _write_csv(path: str, rows: list[list[str]]) -> None:
    with open(path, "w", newline="") as f:
        csv.writer(f).writerows(rows)


def _format_date(d: date) -> str:
    return d.strftime("%d/%m/%y")


def _last_data_date(rows: list[list[str]]) -> date | None:
    data_rows = [r for r in rows if r and not r[0].strip().lower().startswith("date")]
    if not data_rows:
        return None
    last = data_rows[-1][0].strip()
    try:
        d, m, y = last.split("/")
        y = int(y)
        if y < 100:
            y += 2000
        return date(y, int(m), int(d))
    except Exception:
        return None


def _upsert_row(rows: list[list[str]], target_date: date, new_row: list) -> list[list[str]]:
    target_str = _format_date(target_date)
    for i, row in enumerate(rows):
        if row and row[0].strip() == target_str:
            rows[i] = new_row
            print(f"[RTM] Updated existing row for {target_str}")
            return rows
    rows.append(new_row)
    print(f"[RTM] Appended new row for {target_str}")
    return rows


# ── Playwright helpers ────────────────────────────────────────────────────────

def _make_browser_context(pw):
    browser = pw.chromium.launch(
        headless=True,
        args=[
            "--no-sandbox",
            "--disable-blink-features=AutomationControlled",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--window-size=1280,800",
        ],
    )
    context = browser.new_context(
        user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ),
        viewport={"width": 1280, "height": 800},
        locale="en-IN",
        java_script_enabled=True,
    )
    context.add_init_script("""
        Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
        Object.defineProperty(navigator, 'plugins',   {get: () => [1, 2, 3]});
        Object.defineProperty(navigator, 'languages', {get: () => ['en-IN', 'en']});
    """)
    return browser, context


def _debug_page(page, label: str) -> None:
    try:
        title = page.title()
        print(f"[RTM] [{label}] title='{title}'")
        # Print visible text snippet for Cloudflare challenge detection
        body_text = page.inner_text("body")[:400].replace("\n", " ")
        print(f"[RTM] [{label}] body_preview='{body_text}'")
        shot = f"/tmp/iex_rtm_{label}.png"
        page.screenshot(path=shot, full_page=True)
        print(f"[RTM] [{label}] screenshot: {shot}")
    except Exception as e:
        print(f"[RTM] [{label}] debug error: {e}")


def _click_interval_tab(page, interval: str) -> bool:
    """Try several selector strategies to click the interval tab."""
    selectors = [
        f"button:has-text('{interval}')",
        f"[role='tab']:has-text('{interval}')",
        f".MuiTab-root:has-text('{interval}')",
        f"a:has-text('{interval}')",
        f"li:has-text('{interval}')",
        f"span:has-text('{interval}')",
    ]
    for sel in selectors:
        try:
            page.wait_for_selector(sel, timeout=8000)
            page.locator(sel).first.click()
            print(f"[RTM] Clicked '{interval}' tab via: {sel}")
            return True
        except Exception:
            continue
    return False


def _select_period(page, period: str) -> bool:
    """Try to pick the delivery period from the dropdown."""
    for combo_sel in ["[role='combobox']", "select", "[aria-haspopup='listbox']"]:
        try:
            combo = page.locator(combo_sel).first
            combo.wait_for(timeout=5000)
            combo.click()
            page.wait_for_timeout(600)
            for opt_sel in [
                f"[role='option']:has-text('{period}')",
                f"li:has-text('{period}')",
                f"option:has-text('{period}')",
            ]:
                try:
                    page.locator(opt_sel).first.click(timeout=5000)
                    print(f"[RTM] Selected period '{period}' via: {opt_sel}")
                    return True
                except Exception:
                    continue
        except Exception:
            continue
    return False


def _parse_table(page) -> tuple[list[str], list[list[str]]]:
    try:
        header_cells = page.locator("table thead th").all()
        if not header_cells:
            header_cells = page.locator("table tr:first-child th, table tr:first-child td").all()
        headers = [th.inner_text().strip() for th in header_cells]
        data = []
        for tr in page.locator("table tbody tr").all():
            cells = [td.inner_text().strip() for td in tr.locator("td").all()]
            if cells:
                data.append(cells)
        return headers, data
    except Exception as e:
        print(f"[RTM] Table parse error: {e}")
        return [], []


def _mcp_col_index(headers: list[str]) -> int | None:
    for i, h in enumerate(headers):
        if "MCP" in h.upper():
            return i
    return None


def _hour_col_index(headers: list[str]) -> int | None:
    for i, h in enumerate(headers):
        if h.strip().lower() == "hour":
            return i
    return None


def _parse_float(s: str) -> float | None:
    try:
        v = float(s.replace(",", "").strip())
        return v if v > 0 else None
    except Exception:
        return None


def _navigate_and_prepare(page, url: str) -> None:
    """Load page and wait for React to fully hydrate."""
    page.goto(url, wait_until="domcontentloaded", timeout=90000)
    # Wait for network to settle after React hydration
    try:
        page.wait_for_load_state("networkidle", timeout=20000)
    except Exception:
        pass
    # Extra buffer for client-side rendering
    page.wait_for_timeout(5000)
    _debug_page(page, "after_load")


# ── Fetch functions ───────────────────────────────────────────────────────────

def fetch_daily_mcp(period: str) -> float | None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("[RTM] Playwright not installed.")
        return None

    print(f"[RTM] Fetching Daily tab, period='{period}'...")
    with sync_playwright() as pw:
        browser, context = _make_browser_context(pw)
        page = context.new_page()
        try:
            _navigate_and_prepare(page, IEX_RTM_URL)

            if not _click_interval_tab(page, "Daily"):
                _debug_page(page, "daily_tab_missing")
                return None
            page.wait_for_timeout(2000)

            if not _select_period(page, period):
                print(f"[RTM] WARNING: period '{period}' not selected, using page default")
            try:
                page.wait_for_load_state("networkidle", timeout=10000)
            except Exception:
                pass
            page.wait_for_timeout(2000)

            headers, data = _parse_table(page)
            print(f"[RTM] Daily headers={headers}, rows={len(data)}")
            mcp_col = _mcp_col_index(headers)
            if mcp_col is None:
                _debug_page(page, "daily_no_mcp_col")
                return None

            mcps = [
                _parse_float(row[mcp_col])
                for row in data
                if mcp_col < len(row) and _parse_float(row[mcp_col]) is not None
            ]
            if not mcps:
                _debug_page(page, "daily_no_mcp_values")
                return None

            avg = round(mean(mcps) / 1000, 4)
            print(f"[RTM] Daily avg MCP: {avg} Rs/Unit (n={len(mcps)})")
            return avg
        except Exception as e:
            print(f"[RTM] Daily fetch exception: {e}")
            try:
                _debug_page(page, "daily_exception")
            except Exception:
                pass
        finally:
            browser.close()
    return None


def fetch_hourly_solar_nonsolar(period: str) -> tuple[float | None, float | None]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("[RTM] Playwright not installed.")
        return None, None

    print(f"[RTM] Fetching Hourly tab, period='{period}'...")
    with sync_playwright() as pw:
        browser, context = _make_browser_context(pw)
        page = context.new_page()
        try:
            _navigate_and_prepare(page, IEX_RTM_URL)

            if not _click_interval_tab(page, "Hourly"):
                _debug_page(page, "hourly_tab_missing")
                return None, None
            page.wait_for_timeout(2000)

            if not _select_period(page, period):
                print(f"[RTM] WARNING: period '{period}' not selected, using page default")
            try:
                page.wait_for_load_state("networkidle", timeout=10000)
            except Exception:
                pass
            page.wait_for_timeout(2000)

            headers, data = _parse_table(page)
            print(f"[RTM] Hourly headers={headers}, rows={len(data)}")
            hour_col = _hour_col_index(headers)
            mcp_col  = _mcp_col_index(headers)
            if hour_col is None or mcp_col is None:
                _debug_page(page, "hourly_no_cols")
                return None, None

            solar_mcps, nonsolar_mcps = [], []
            for row in data:
                if max(hour_col, mcp_col) >= len(row):
                    continue
                try:
                    hour = int(row[hour_col].strip())
                except Exception:
                    continue
                mcp = _parse_float(row[mcp_col])
                if mcp is None:
                    continue
                mcp_unit = mcp / 1000
                if hour in SOLAR_HOURS:
                    solar_mcps.append(mcp_unit)
                elif hour in NONSOLAR_HOURS:
                    nonsolar_mcps.append(mcp_unit)

            solar_avg    = round(mean(solar_mcps),    4) if solar_mcps    else None
            nonsolar_avg = round(mean(nonsolar_mcps), 4) if nonsolar_mcps else None
            print(
                f"[RTM] Solar={solar_avg} ({len(solar_mcps)} hrs), "
                f"NonSolar={nonsolar_avg} ({len(nonsolar_mcps)} hrs)"
            )
            return solar_avg, nonsolar_avg
        except Exception as e:
            print(f"[RTM] Hourly fetch exception: {e}")
            try:
                _debug_page(page, "hourly_exception")
            except Exception:
                pass
        finally:
            browser.close()
    return None, None


# ── Main ──────────────────────────────────────────────────────────────────────

def scrape_rtm(target_date: date, period_label: str) -> bool:
    csv_path = CSV_PATHS["rtm"]
    rows = _read_csv(csv_path)

    if period_label.lower() == "yesterday":
        last = _last_data_date(rows)
        if last and last >= target_date:
            print(f"[RTM] Data for {target_date} already present. Skipping.")
            return True

    print(f"[RTM] Scraping period='{period_label}' for date={target_date}...")

    daily_avg = fetch_daily_mcp(period_label)
    solar_avg, nonsolar_avg = fetch_hourly_solar_nonsolar(period_label)

    if daily_avg is None:
        print(f"[RTM] ERROR: Could not get daily MCP for {target_date}.")
        return False

    if solar_avg is None:
        print("[RTM] WARNING: Solar avg unavailable; using daily avg.")
        solar_avg = daily_avg
    if nonsolar_avg is None:
        print("[RTM] WARNING: NonSolar avg unavailable; using daily avg.")
        nonsolar_avg = daily_avg

    new_row = [_format_date(target_date), daily_avg, solar_avg, nonsolar_avg]
    print(f"[RTM] Writing row: {new_row}")

    if period_label.lower() == "today":
        rows = _upsert_row(rows, target_date, new_row)
        _write_csv(csv_path, rows)
    else:
        with open(csv_path, "a", newline="") as f:
            csv.writer(f).writerow(new_row)

    print(f"[RTM] Done ({period_label}).")
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scrape IEX RTM prices")
    parser.add_argument(
        "--period",
        choices=["yesterday", "today"],
        default="yesterday",
        help="'yesterday' (nightly) or 'today' (hourly live)",
    )
    args = parser.parse_args()

    if args.period == "yesterday":
        target  = date.today() - timedelta(days=1)
        p_label = "Yesterday"
    else:
        target  = date.today()
        p_label = "Today"

    success = scrape_rtm(target, p_label)
    sys.exit(0 if success else 1)
