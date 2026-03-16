"""
Scrape IEX Real-Time Market (RTM) data via Playwright URL navigation.

Usage:
  python scrape_iex_rtm.py                   # yesterday's finalized data (nightly cron)
  python scrape_iex_rtm.py --period today    # today's live partial data (hourly cron)

Columns written to RTM Prices.csv:
  Date, RTM price (daily avg MCP Rs/Unit), Solar_Avg, NonSolar_Avg

URL param approach (confirmed from browser DevTools):
  ?interval=DAILY&dp=LAST_8_DAYS&showGraph=false  → daily avg per date
  ?interval=HOURLY&dp=LAST_8_DAYS&showGraph=false → hourly breakdown per date
  Multiple rows per day — filter to target date, average MCP ÷ 1000
"""

import argparse
import csv
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from statistics import mean

sys.path.insert(0, str(Path(__file__).parent))
from config import CSV_PATHS

IEX_RTM_URL = "https://www.iexindia.com/market-data/real-time-market/market-snapshot"

# IEX Hourly tab: Hour column is 1-indexed (Hour 1 = 00:00-01:00 IST)
SOLAR_HOURS    = set(range(7, 19))           # Hour 7-18 → 06:00-18:00 IST
NONSOLAR_HOURS = set(range(1, 7)) | set(range(19, 25))  # 1-6 + 19-24


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
        print(f"[RTM] [{label}] title='{page.title()}'")
        body = page.inner_text("body")[:300].replace("\n", " ")
        print(f"[RTM] [{label}] body='{body}'")
        page.screenshot(path=f"/tmp/iex_rtm_{label}.png", full_page=True)
    except Exception as e:
        print(f"[RTM] [{label}] debug error: {e}")


def _navigate(page, url: str) -> None:
    """Load page and wait for the Market Snapshot section to render."""
    page.goto(url, wait_until="domcontentloaded", timeout=90000)
    try:
        page.wait_for_load_state("networkidle", timeout=20000)
    except Exception:
        pass
    # Wait for the Interval dropdown to appear — confirms React has hydrated
    page.wait_for_selector("[role='combobox']", timeout=30000)
    page.wait_for_timeout(1000)
    _debug_page(page, "after_load")


def _click_dropdown_and_select(page, combo_index: int, option_text: str) -> bool:
    """
    Click the nth combobox (0-indexed) and select an option by text.
    Returns True on success.
    """
    try:
        combos = page.locator("[role='combobox']").all()
        print(f"[RTM] Found {len(combos)} comboboxes")
        if combo_index >= len(combos):
            print(f"[RTM] No combobox at index {combo_index}")
            return False
        combos[combo_index].click()
        page.wait_for_timeout(600)
        # Options appear in a portal/listbox
        opt = page.locator(
            f"[role='option']:has-text('{option_text}'), "
            f"li:has-text('{option_text}')"
        ).first
        opt.wait_for(timeout=5000)
        opt.click()
        print(f"[RTM] Selected '{option_text}' from combobox[{combo_index}]")
        page.wait_for_timeout(500)
        return True
    except Exception as e:
        print(f"[RTM] Dropdown select failed (combo={combo_index}, option='{option_text}'): {e}")
        return False


def _wait_for_table(page) -> None:
    try:
        page.wait_for_selector("table tbody tr", timeout=15000)
    except Exception:
        pass
    page.wait_for_timeout(1500)


def _parse_main_table(page) -> tuple[list[str], list[list[str]]]:
    """Parse the first <table> on the page (main data table)."""
    try:
        tables = page.locator("table").all()
        if not tables:
            return [], []
        tbl = tables[0]
        header_cells = tbl.locator("thead th").all()
        if not header_cells:
            header_cells = tbl.locator("tr:first-child th, tr:first-child td").all()
        headers = [th.inner_text().strip() for th in header_cells]
        data = []
        for tr in tbl.locator("tbody tr").all():
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


def _parse_iex_date(s: str) -> date | None:
    s = s.strip()
    for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%d-%b-%Y", "%Y-%m-%d", "%d-%m-%y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


# ── Fetch functions ───────────────────────────────────────────────────────────

def fetch_daily_mcp(target_date: date) -> float | None:
    """
    Navigate to IEX RTM URL with interval=DAILY&dp=LAST_8_DAYS, filter rows
    for target_date, return mean MCP ÷ 1000 (Rs/Unit).

    URL navigation avoids the dropdown interaction bug: selecting 'Daily'
    interval removes 'Today'/'Yesterday' from delivery period options, causing
    the old UI approach to silently average across all 8 days instead of one.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("[RTM] Playwright not installed.")
        return None

    url = f"{IEX_RTM_URL}?interval=DAILY&dp=LAST_8_DAYS&showGraph=false"
    print(f"[RTM] fetch_daily_mcp target={target_date}")

    with sync_playwright() as pw:
        browser, context = _make_browser_context(pw)
        page = context.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=90000)
            try:
                page.wait_for_load_state("networkidle", timeout=20000)
            except Exception:
                pass
            try:
                page.wait_for_selector("table tbody tr", timeout=20000)
            except Exception:
                pass
            page.wait_for_timeout(1500)

            headers, data = _parse_main_table(page)
            print(f"[RTM] Daily headers={headers}, total rows={len(data)}")

            date_col = next((i for i, h in enumerate(headers) if "date" in h.lower()), None)
            mcp_col  = _mcp_col_index(headers)
            if date_col is None or mcp_col is None:
                _debug_page(page, "daily_no_cols")
                return None

            mcps = []
            for row in data:
                if max(date_col, mcp_col) >= len(row):
                    continue
                d = _parse_iex_date(row[date_col])
                if d != target_date:
                    continue
                v = _parse_float(row[mcp_col])
                if v is not None:
                    mcps.append(v)

            print(f"[RTM] {target_date}: {len(mcps)} blocks with MCP data")
            if not mcps:
                _debug_page(page, "daily_empty_mcp")
                return None

            avg = round(mean(mcps) / 1000, 4)
            print(f"[RTM] avg MCP for {target_date}: {avg} Rs/Unit")
            return avg
        except Exception as e:
            print(f"[RTM] fetch_daily_mcp exception: {e}")
            try:
                _debug_page(page, "daily_exception")
            except Exception:
                pass
        finally:
            browser.close()
    return None


def fetch_hourly_solar_nonsolar(target_date: date) -> tuple[float | None, float | None]:
    """
    Navigate to IEX RTM URL with interval=HOURLY&dp=LAST_8_DAYS, filter rows
    for target_date, return (solar_avg, nonsolar_avg) in Rs/Unit.
    Solar  = hours 7-18 (6am-6pm IST)
    NonSolar = hours 1-6 + 19-24
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("[RTM] Playwright not installed.")
        return None, None

    url = f"{IEX_RTM_URL}?interval=HOURLY&dp=LAST_8_DAYS&showGraph=false"
    print(f"[RTM] fetch_hourly_solar_nonsolar target={target_date}")

    with sync_playwright() as pw:
        browser, context = _make_browser_context(pw)
        page = context.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=90000)
            try:
                page.wait_for_load_state("networkidle", timeout=20000)
            except Exception:
                pass
            try:
                page.wait_for_selector("table tbody tr", timeout=20000)
            except Exception:
                pass
            page.wait_for_timeout(1500)

            headers, data = _parse_main_table(page)
            print(f"[RTM] Hourly headers={headers}, total rows={len(data)}")

            date_col = next((i for i, h in enumerate(headers) if "date" in h.lower()), None)
            hour_col = _hour_col_index(headers)
            mcp_col  = _mcp_col_index(headers)
            if date_col is None or hour_col is None or mcp_col is None:
                _debug_page(page, "hourly_no_cols")
                return None, None

            solar_mcps, nonsolar_mcps = [], []
            current_date: date | None = None
            for row in data:
                if max(date_col, hour_col, mcp_col) >= len(row):
                    continue
                raw_date = row[date_col].strip()
                if raw_date:
                    parsed = _parse_iex_date(raw_date)
                    if parsed:
                        current_date = parsed
                if current_date != target_date:
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
            print(f"[RTM] fetch_hourly exception: {e}")
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

    daily_avg = fetch_daily_mcp(target_date)
    solar_avg, nonsolar_avg = fetch_hourly_solar_nonsolar(target_date)

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
