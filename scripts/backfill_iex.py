"""
Backfill missing IEX RTM and DAM price data.

Usage:
  python backfill_iex.py --market dam --period "Last 31 Days"
  python backfill_iex.py --market rtm --period "Last 31 Days"
  python backfill_iex.py --market both --period "Last 31 Days"

Strategy:
  1. Open IEX page, select Interval=Daily, Delivery Period=<period>
  2. Parse ALL date rows from the table
  3. For RTM: also fetch Hourly data to compute solar/non-solar averages per date
  4. For each date in scraped results:
     - If date already exists in CSV → skip (don't overwrite good data)
     - If date is missing → insert it in chronological order
  5. Write back the merged CSV

Run twice if needed — once for "Last 31 Days" (covers last ~31 days),
and if the gap is older, IEX only supports up to 31 days back via UI.
"""

import argparse
import csv
import sys
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path
from statistics import mean

sys.path.insert(0, str(Path(__file__).parent))
from config import CSV_PATHS

IEX_RTM_URL = "https://www.iexindia.com/market-data/real-time-market/market-snapshot"
IEX_DAM_URL = "https://www.iexindia.com/market-data/day-ahead-market/market-snapshot"

SOLAR_HOURS    = set(range(7, 19))
NONSOLAR_HOURS = set(range(1, 7)) | set(range(19, 25))


# ── Date helpers ──────────────────────────────────────────────────────────────

def _parse_iex_date(s: str) -> date | None:
    """Parse IEX date formats: '09-03-2026' or '09/03/2026' → date object."""
    s = s.strip()
    for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%d-%b-%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _format_date(d: date) -> str:
    return d.strftime("%d/%m/%y")


def _parse_csv_date(s: str) -> date | None:
    s = s.strip()
    try:
        parts = s.split("/")
        d, m, y = int(parts[0]), int(parts[1]), int(parts[2])
        if y < 100:
            y += 2000
        return date(y, m, d)
    except Exception:
        return None


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


def _existing_dates(rows: list[list[str]]) -> set[date]:
    result = set()
    for row in rows:
        if row and not row[0].strip().lower().startswith("date"):
            d = _parse_csv_date(row[0])
            if d:
                result.add(d)
    return result


def _merge_rows(existing_rows: list[list[str]], new_rows: dict[date, list]) -> list[list[str]]:
    """
    Insert new_rows (dict of date → csv_row) into existing_rows, sorted by date.
    Header row (if any) is preserved at the top.
    """
    # Separate header
    header = None
    data_rows = []
    for row in existing_rows:
        if row and row[0].strip().lower().startswith("date"):
            header = row
        else:
            data_rows.append(row)

    # Build map of existing date → row
    existing_map: dict[date, list] = {}
    undated = []
    for row in data_rows:
        if row:
            d = _parse_csv_date(row[0])
            if d:
                existing_map[d] = row
            else:
                undated.append(row)

    # Merge (existing wins)
    merged = {**new_rows, **existing_map}  # existing_map takes priority

    # Sort by date
    sorted_rows = [merged[d] for d in sorted(merged.keys())]

    result = []
    if header:
        result.append(header)
    result.extend(sorted_rows)
    result.extend(undated)
    return result


def _parse_float(s: str) -> float | None:
    try:
        v = float(s.replace(",", "").strip())
        return v if v > 0 else None
    except Exception:
        return None


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


def _navigate(page, url: str, label: str) -> None:
    page.goto(url, wait_until="domcontentloaded", timeout=90000)
    try:
        page.wait_for_load_state("networkidle", timeout=20000)
    except Exception:
        pass
    page.wait_for_selector("[role='combobox']", timeout=30000)
    page.wait_for_timeout(1000)
    print(f"[{label}] Page loaded: {page.title()}")


def _click_dropdown_and_select(page, combo_index: int, option_text: str, label: str) -> bool:
    try:
        combos = page.locator("[role='combobox']").all()
        if combo_index >= len(combos):
            print(f"[{label}] No combobox at index {combo_index} (found {len(combos)})")
            return False
        combos[combo_index].click()
        page.wait_for_timeout(600)
        opt = page.locator(
            f"[role='option']:has-text('{option_text}'), li:has-text('{option_text}')"
        ).first
        opt.wait_for(timeout=5000)
        opt.click()
        print(f"[{label}] Selected '{option_text}' from combobox[{combo_index}]")
        page.wait_for_timeout(500)
        return True
    except Exception as e:
        print(f"[{label}] Dropdown select failed (combo={combo_index}, '{option_text}'): {e}")
        return False


def _wait_for_table(page) -> None:
    try:
        page.wait_for_selector("table tbody tr", timeout=15000)
    except Exception:
        pass
    page.wait_for_timeout(2000)


def _parse_main_table(page) -> tuple[list[str], list[list[str]]]:
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
        print(f"Table parse error: {e}")
        return [], []


def _col_index(headers: list[str], keyword: str) -> int | None:
    kw = keyword.upper()
    for i, h in enumerate(headers):
        if kw in h.upper():
            return i
    return None


# ── Scrape functions ──────────────────────────────────────────────────────────

def scrape_daily_all_dates(url: str, period: str, label: str) -> dict[date, float]:
    """
    Select Interval=Daily, Delivery Period=period.
    Returns {date: mcp_rs_per_unit} for all rows in the table.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(f"[{label}] Playwright not installed.")
        return {}

    print(f"[{label}] Scraping Daily / '{period}'...")
    result: dict[date, float] = {}

    with sync_playwright() as pw:
        browser, context = _make_browser_context(pw)
        page = context.new_page()
        try:
            _navigate(page, url, label)

            if not _click_dropdown_and_select(page, 0, "Daily", label):
                print(f"[{label}] Could not select Daily interval.")
                return {}
            _wait_for_table(page)

            if not _click_dropdown_and_select(page, 1, period, label):
                print(f"[{label}] WARNING: could not select period '{period}'")
            _wait_for_table(page)

            headers, data = _parse_main_table(page)
            print(f"[{label}] Daily: headers={headers}, rows={len(data)}")

            date_col = _col_index(headers, "Date")
            mcp_col  = _col_index(headers, "MCP")
            if date_col is None or mcp_col is None:
                print(f"[{label}] ERROR: could not find Date/MCP columns. headers={headers}")
                page.screenshot(path=f"/tmp/iex_{label.lower()}_backfill_daily.png", full_page=True)
                return {}

            for row in data:
                if max(date_col, mcp_col) >= len(row):
                    continue
                d = _parse_iex_date(row[date_col])
                mcp = _parse_float(row[mcp_col])
                if d and mcp:
                    result[d] = round(mcp / 1000, 4)

            print(f"[{label}] Parsed {len(result)} date entries from Daily table")
        except Exception as e:
            print(f"[{label}] scrape_daily_all_dates exception: {e}")
            try:
                page.screenshot(path=f"/tmp/iex_{label.lower()}_backfill_err.png", full_page=True)
            except Exception:
                pass
        finally:
            browser.close()

    return result


def scrape_hourly_all_dates(url: str, period: str, label: str) -> dict[date, tuple[float, float]]:
    """
    Select Interval=Hourly, Delivery Period=period.
    Returns {date: (solar_avg, nonsolar_avg)} for all dates with enough data.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(f"[{label}] Playwright not installed.")
        return {}

    print(f"[{label}] Scraping Hourly / '{period}'...")
    result: dict[date, tuple[float, float]] = {}

    with sync_playwright() as pw:
        browser, context = _make_browser_context(pw)
        page = context.new_page()
        try:
            _navigate(page, url, label)

            if not _click_dropdown_and_select(page, 0, "Hourly", label):
                print(f"[{label}] Could not select Hourly interval.")
                return {}
            _wait_for_table(page)

            if not _click_dropdown_and_select(page, 1, period, label):
                print(f"[{label}] WARNING: could not select period '{period}'")
            _wait_for_table(page)

            headers, data = _parse_main_table(page)
            print(f"[{label}] Hourly: headers={headers}, rows={len(data)}")

            date_col = _col_index(headers, "Date")
            hour_col = next((i for i, h in enumerate(headers) if h.strip().lower() == "hour"), None)
            mcp_col  = _col_index(headers, "MCP")
            if date_col is None or hour_col is None or mcp_col is None:
                print(f"[{label}] ERROR: missing Date/Hour/MCP cols. headers={headers}")
                return {}

            # Group by date
            solar_by_date:    defaultdict[date, list[float]] = defaultdict(list)
            nonsolar_by_date: defaultdict[date, list[float]] = defaultdict(list)

            current_date = None
            for row in data:
                if max(date_col, hour_col, mcp_col) >= len(row):
                    continue
                # IEX Hourly table: Date column may be blank for rows after the first row of a date
                raw_date = row[date_col].strip()
                if raw_date:
                    d = _parse_iex_date(raw_date)
                    if d:
                        current_date = d
                if current_date is None:
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
                    solar_by_date[current_date].append(mcp_unit)
                elif hour in NONSOLAR_HOURS:
                    nonsolar_by_date[current_date].append(mcp_unit)

            for d in set(solar_by_date) | set(nonsolar_by_date):
                s_list = solar_by_date.get(d, [])
                n_list = nonsolar_by_date.get(d, [])
                solar_avg    = round(mean(s_list), 4) if s_list else None
                nonsolar_avg = round(mean(n_list), 4) if n_list else None
                result[d] = (solar_avg, nonsolar_avg)

            print(f"[{label}] Hourly: got solar/nonsolar for {len(result)} dates")
        except Exception as e:
            print(f"[{label}] scrape_hourly_all_dates exception: {e}")
        finally:
            browser.close()

    return result


# ── Backfill logic ────────────────────────────────────────────────────────────

def backfill_dam(period: str) -> int:
    csv_path = CSV_PATHS["dam"]
    rows = _read_csv(csv_path)
    existing = _existing_dates(rows)

    daily = scrape_daily_all_dates(IEX_DAM_URL, period, "DAM")
    if not daily:
        print("[DAM] No data scraped. Aborting.")
        return 0

    missing = {d: v for d, v in daily.items() if d not in existing}
    print(f"[DAM] Found {len(daily)} scraped dates, {len(missing)} missing from CSV")

    if not missing:
        print("[DAM] Nothing to backfill.")
        return 0

    new_rows = {d: [_format_date(d), v, "", ""] for d, v in missing.items()}
    merged = _merge_rows(rows, new_rows)
    _write_csv(csv_path, merged)

    added = sorted(missing.keys())
    print(f"[DAM] Added {len(added)} rows: {[_format_date(d) for d in added]}")
    return len(added)


def backfill_rtm(period: str) -> int:
    csv_path = CSV_PATHS["rtm"]
    rows = _read_csv(csv_path)
    existing = _existing_dates(rows)

    daily   = scrape_daily_all_dates(IEX_RTM_URL, period, "RTM")
    hourly  = scrape_hourly_all_dates(IEX_RTM_URL, period, "RTM")

    if not daily:
        print("[RTM] No daily data scraped. Aborting.")
        return 0

    missing = {d: v for d, v in daily.items() if d not in existing}
    print(f"[RTM] Found {len(daily)} scraped dates, {len(missing)} missing from CSV")

    # Also fix placeholder rows (solar == daily avg, which we set as placeholder)
    # Identified by solar_avg == nonsolar_avg == rtm_price (placeholder pattern)
    placeholder_dates: set[date] = set()
    for row in rows:
        if row and not row[0].strip().lower().startswith("date"):
            d = _parse_csv_date(row[0])
            if d and d in existing and len(row) >= 4:
                rtm = _parse_float(row[1])
                solar = _parse_float(row[2])
                nonsolar = _parse_float(row[3])
                if rtm and solar and nonsolar and solar == rtm and nonsolar == rtm:
                    placeholder_dates.add(d)

    if placeholder_dates:
        print(f"[RTM] Found {len(placeholder_dates)} rows with placeholder solar/nonsolar: "
              f"{[_format_date(d) for d in sorted(placeholder_dates)]}")

    if not missing and not placeholder_dates:
        print("[RTM] Nothing to backfill.")
        return 0

    # Build new_rows for missing dates
    new_rows: dict[date, list] = {}
    for d, rtm_price in missing.items():
        solar_avg, nonsolar_avg = hourly.get(d, (None, None))
        solar_avg    = solar_avg    if solar_avg    is not None else rtm_price
        nonsolar_avg = nonsolar_avg if nonsolar_avg is not None else rtm_price
        new_rows[d] = [_format_date(d), rtm_price, solar_avg, nonsolar_avg]

    # Fix placeholder rows in-place
    fixed = 0
    updated_rows = list(rows)
    for i, row in enumerate(updated_rows):
        if row and not row[0].strip().lower().startswith("date"):
            d = _parse_csv_date(row[0])
            if d and d in placeholder_dates and d in hourly:
                solar_avg, nonsolar_avg = hourly[d]
                rtm_price = _parse_float(row[1])
                if solar_avg is not None:
                    updated_rows[i][2] = str(solar_avg)
                    fixed += 1
                if nonsolar_avg is not None:
                    updated_rows[i][3] = str(nonsolar_avg)

    merged = _merge_rows(updated_rows, new_rows)
    _write_csv(csv_path, merged)

    added = sorted(missing.keys())
    print(f"[RTM] Added {len(added)} rows, fixed {fixed} placeholder solar/nonsolar values")
    if added:
        print(f"[RTM] Added dates: {[_format_date(d) for d in added]}")
    return len(added) + fixed


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill missing IEX RTM/DAM data")
    parser.add_argument(
        "--market",
        choices=["rtm", "dam", "both"],
        default="both",
        help="Which market to backfill (default: both)",
    )
    parser.add_argument(
        "--period",
        default="Last 31 Days",
        help="IEX delivery period to use (default: 'Last 31 Days')",
    )
    args = parser.parse_args()

    total = 0
    if args.market in ("dam", "both"):
        total += backfill_dam(args.period)
    if args.market in ("rtm", "both"):
        total += backfill_rtm(args.period)

    print(f"\nBackfill complete. Total rows added/fixed: {total}")
    sys.exit(0 if total >= 0 else 1)
