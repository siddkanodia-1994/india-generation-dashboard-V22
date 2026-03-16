"""
Scrape IEX Real-Time Market (RTM) data via Playwright UI simulation.

Usage:
  python scrape_iex_rtm.py                   # yesterday's finalized data (nightly cron)
  python scrape_iex_rtm.py --period today    # today's live partial data (hourly cron)

Columns written to RTM Prices.csv:
  Date, RTM price (daily avg MCP Rs/Unit), Solar_Avg, NonSolar_Avg

Strategy:
  - Navigate to IEX RTM page
  - Click "Daily" interval tab → select delivery period → parse HTML table → daily MCP ÷ 1000
  - Click "Hourly" interval tab → select delivery period → parse Hour + MCP columns
    Solar avg  = hours 7–18  (6am–6pm IST)
    NonSolar avg = hours 1–6 + 19–24 (6pm–6am IST)
  - For "Today": only average hours with data (partial day OK)
  - For "Yesterday": append row if not already present
  - For "Today": upsert (overwrite today's row if exists, else append)
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

# IEX "Hourly" tab: Hour column is 1-indexed (Hour 1 = 00:00–01:00 IST)
SOLAR_HOURS    = set(range(7, 19))           # Hour 7–18 → 06:00–18:00 IST
NONSOLAR_HOURS = set(range(1, 7)) | set(range(19, 25))  # 1–6 + 19–24


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
    """Replace existing row for target_date, or append if not found."""
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
        ],
    )
    context = browser.new_context(
        user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ),
        viewport={"width": 1280, "height": 800},
        locale="en-IN",
    )
    context.add_init_script(
        "Object.defineProperty(navigator, 'webdriver', {get: () => undefined});"
    )
    return browser, context


def _select_interval_and_period(page, interval: str, period: str) -> None:
    """Click an interval tab (e.g. 'Daily', 'Hourly') then pick a delivery period."""
    tab_selector = (
        f"button:has-text('{interval}'), "
        f"[role='tab']:has-text('{interval}')"
    )
    page.wait_for_selector(tab_selector, timeout=30000)
    page.locator(tab_selector).first.click()
    page.wait_for_timeout(1500)

    # Material-UI Select — click the combobox, then pick the matching option
    combo = page.locator("[role='combobox']").first
    combo.click()
    page.wait_for_timeout(500)
    page.locator(f"[role='option']:has-text('{period}')").first.click()

    page.wait_for_load_state("networkidle", timeout=20000)
    page.wait_for_timeout(2000)


def _parse_table(page) -> tuple[list[str], list[list[str]]]:
    """Return (headers, data_rows) from the rendered HTML table."""
    try:
        header_cells = page.locator("table thead th").all()
        if not header_cells:
            header_cells = page.locator("table tr:first-child th, table tr:first-child td").all()
        headers = [th.inner_text().strip() for th in header_cells]

        body_rows = page.locator("table tbody tr").all()
        data = []
        for tr in body_rows:
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


# ── Fetch functions ───────────────────────────────────────────────────────────

def fetch_daily_mcp(period: str) -> float | None:
    """Return daily avg MCP in Rs/Unit (MCP Rs/MWh ÷ 1000)."""
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
            page.goto(IEX_RTM_URL, wait_until="domcontentloaded", timeout=90000)
            _select_interval_and_period(page, "Daily", period)
            headers, data = _parse_table(page)
            print(f"[RTM] Daily: headers={headers}, rows={len(data)}")
            mcp_col = _mcp_col_index(headers)
            if mcp_col is None:
                print("[RTM] ERROR: MCP column not found in Daily table.")
                return None
            mcps = []
            for row in data:
                if mcp_col < len(row):
                    v = _parse_float(row[mcp_col])
                    if v is not None:
                        mcps.append(v)
            if not mcps:
                print("[RTM] No valid MCP values in Daily table.")
                return None
            avg = round(mean(mcps) / 1000, 4)
            print(f"[RTM] Daily avg MCP: {avg} Rs/Unit (n={len(mcps)})")
            return avg
        except Exception as e:
            print(f"[RTM] Daily fetch exception: {e}")
        finally:
            browser.close()
    return None


def fetch_hourly_solar_nonsolar(period: str) -> tuple[float | None, float | None]:
    """
    Fetch Hourly tab data and return (solar_avg, nonsolar_avg) in Rs/Unit.
    For 'Today', only includes hours that have data (MCP > 0).
    """
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
            page.goto(IEX_RTM_URL, wait_until="domcontentloaded", timeout=90000)
            _select_interval_and_period(page, "Hourly", period)
            headers, data = _parse_table(page)
            print(f"[RTM] Hourly: headers={headers}, rows={len(data)}")
            hour_col = _hour_col_index(headers)
            mcp_col  = _mcp_col_index(headers)
            if hour_col is None or mcp_col is None:
                print(f"[RTM] ERROR: Hour col={hour_col}, MCP col={mcp_col}")
                return None, None

            solar_mcps    = []
            nonsolar_mcps = []
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
                f"[RTM] Solar avg={solar_avg} ({len(solar_mcps)} hrs), "
                f"NonSolar avg={nonsolar_avg} ({len(nonsolar_mcps)} hrs)"
            )
            return solar_avg, nonsolar_avg
        except Exception as e:
            print(f"[RTM] Hourly fetch exception: {e}")
        finally:
            browser.close()
    return None, None


# ── Main ──────────────────────────────────────────────────────────────────────

def scrape_rtm(target_date: date, period_label: str) -> bool:
    """
    period_label: "Yesterday" → append (skip if already present)
                  "Today"     → upsert (overwrite today's row each hour)
    """
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

    # Fall back to daily_avg when hourly is unavailable
    if solar_avg is None:
        print("[RTM] WARNING: Solar avg unavailable; using daily avg as fallback.")
        solar_avg = daily_avg
    if nonsolar_avg is None:
        print("[RTM] WARNING: NonSolar avg unavailable; using daily avg as fallback.")
        nonsolar_avg = daily_avg

    new_row = [_format_date(target_date), daily_avg, solar_avg, nonsolar_avg]
    print(f"[RTM] Row to write: {new_row}")

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
        help="Delivery period: 'yesterday' (nightly, default) or 'today' (hourly live)",
    )
    args = parser.parse_args()

    if args.period == "yesterday":
        target   = date.today() - timedelta(days=1)
        p_label  = "Yesterday"
    else:
        target   = date.today()
        p_label  = "Today"

    success = scrape_rtm(target, p_label)
    sys.exit(0 if success else 1)
