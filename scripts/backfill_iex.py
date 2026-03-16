"""
Backfill missing IEX RTM and DAM price data.

Usage — preset period:
  python backfill_iex.py --market dam
  python backfill_iex.py --market rtm
  python backfill_iex.py --market both

Usage — custom date range (auto-split into ≤31-day chunks):
  python backfill_iex.py --market dam --start-date 2026-01-09 --end-date 2026-03-15
  python backfill_iex.py --market both --start-date 2026-01-09 --end-date 2026-03-15

Strategy:
  - For each ≤31-day chunk:
      1. Open IEX page, select Interval=Daily
      2. Select "Custom" from Delivery Period dropdown
      3. Enter start and end dates, click "Update Report"
      4. Parse ALL date rows from the rendered table
      5. For RTM: repeat with Interval=Hourly for solar/non-solar
  - Merge scraped data with existing CSV (existing rows never overwritten)
  - Also fixes RTM placeholder rows (solar == nonsolar == daily avg)

IEX custom date picker:
  - Select "Custom" from Delivery Period dropdown → two date inputs appear
  - Max range = 31 days
  - Click "Update Report" button to load data
"""

import argparse
import csv
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from statistics import mean

sys.path.insert(0, str(Path(__file__).parent))
from config import CSV_PATHS

IEX_RTM_URL = "https://www.iexindia.com/market-data/real-time-market/market-snapshot"
IEX_DAM_URL = "https://www.iexindia.com/market-data/day-ahead-market/market-snapshot"

SOLAR_HOURS    = set(range(7, 19))
NONSOLAR_HOURS = set(range(1, 7)) | set(range(19, 25))
MAX_CHUNK_DAYS = 31


# ── Date helpers ──────────────────────────────────────────────────────────────

def _parse_iex_date(s: str) -> date | None:
    s = s.strip()
    for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%d-%b-%Y", "%Y-%m-%d", "%d-%m-%y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _format_date_csv(d: date) -> str:
    return d.strftime("%d/%m/%y")


def _format_date_iex(d: date) -> str:
    """IEX custom date picker format: DD-MM-YYYY"""
    return d.strftime("%d-%m-%Y")


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


def _date_chunks(start: date, end: date, chunk_size: int = MAX_CHUNK_DAYS) -> list[tuple[date, date]]:
    """Split a date range into chunks of at most chunk_size days."""
    chunks = []
    current = start
    while current <= end:
        chunk_end = min(current + timedelta(days=chunk_size - 1), end)
        chunks.append((current, chunk_end))
        current = chunk_end + timedelta(days=1)
    return chunks


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
    """Insert new_rows into existing_rows in date order. Existing rows win."""
    header = None
    data_rows = []
    for row in existing_rows:
        if row and row[0].strip().lower().startswith("date"):
            header = row
        else:
            data_rows.append(row)

    existing_map: dict[date, list] = {}
    undated = []
    for row in data_rows:
        if row:
            d = _parse_csv_date(row[0])
            if d:
                existing_map[d] = row
            else:
                undated.append(row)

    merged = {**new_rows, **existing_map}  # existing wins
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
    print(f"[{label}] Loaded: {page.title()}")


def _click_dropdown_and_select(page, combo_index: int, option_text: str, label: str) -> bool:
    try:
        combos = page.locator("[role='combobox']").all()
        if combo_index >= len(combos):
            print(f"[{label}] No combobox[{combo_index}] (found {len(combos)})")
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
        print(f"[{label}] Dropdown select failed ({combo_index}, '{option_text}'): {e}")
        # Close the dropdown cleanly so the next call opens it fresh
        try:
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
        except Exception:
            pass
        return False


def _set_custom_date_range(page, start: date, end: date, label: str) -> bool:
    """
    Select 'Custom' (or variant) from Delivery Period, fill in start/end dates, click Update Report.
    IEX shows two date inputs when Custom is selected.
    """
    # Step 1: open the delivery period dropdown (combobox[1]) and find the Custom option
    try:
        combos = page.locator("[role='combobox']").all()
        if len(combos) < 2:
            print(f"[{label}] Only {len(combos)} comboboxes found, need at least 2")
            return False
        combos[1].click()
        page.wait_for_timeout(800)

        # Enumerate all visible options to aid debugging
        all_opts = page.locator("[role='option'], li[role='option']").all()
        opt_texts = [o.inner_text().strip() for o in all_opts]
        print(f"[{label}] Delivery period options: {opt_texts}")
        page.screenshot(path=f"/tmp/iex_{label.lower()}_step1_opts.png")

        # Try candidate labels in order of likelihood
        selected = False
        for candidate in ["-Select Range-", "Custom", "Custom Range", "Custom Date Range", "Customised"]:
            opt = page.locator(
                f"[role='option']:has-text('{candidate}'), li:has-text('{candidate}')"
            ).first
            try:
                if opt.is_visible(timeout=1000):
                    opt.click()
                    print(f"[{label}] Selected custom variant '{candidate}'")
                    selected = True
                    break
            except Exception:
                continue

        if not selected:
            print(f"[{label}] Could not find any Custom option in: {opt_texts}")
            try:
                page.keyboard.press("Escape")
                page.wait_for_timeout(300)
            except Exception:
                pass
            return False
    except Exception as e:
        print(f"[{label}] Could not open delivery period dropdown: {e}")
        try:
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
        except Exception:
            pass
        return False

    page.wait_for_timeout(800)
    page.screenshot(path=f"/tmp/iex_{label.lower()}_step2_custom_selected.png")

    start_str      = _format_date_iex(start)   # DD-MM-YYYY  (for logging)
    end_str        = _format_date_iex(end)
    start_digits   = start_str.replace("-", "")  # DDMMYYYY — MUI DatePicker accepts digits only
    end_digits     = end_str.replace("-", "")

    # Step 2: fill date inputs.
    # MUI Select renders a hidden <input aria-hidden='true'> inside each combobox.
    # Filtering those out leaves only the visible date picker inputs.
    filled_start = False
    filled_end   = False

    date_input_selectors = [
        # Best: excludes MUI Select's hidden inputs → only real date fields remain
        "input:not([aria-hidden='true']):not([type='hidden'])",
        # Broader fallbacks
        "input[placeholder*='Date'], input[placeholder*='date']",
        "input[placeholder*='From'], input[placeholder*='from']",
        "input[type='date']",
        "input[type='text']",
    ]

    for sel in date_input_selectors:
        try:
            all_inputs = page.locator(sel).all()
            # Filter to visible, enabled inputs only (skips disabled/hidden elements)
            inputs = [inp for inp in all_inputs if inp.is_visible() and inp.is_enabled()]
            if len(inputs) >= 2:
                # MUI DatePicker: click, then Home to guarantee cursor is at DD (first section)
                inputs[0].click()
                page.wait_for_timeout(200)
                page.keyboard.press("Home")
                page.wait_for_timeout(100)
                inputs[0].type(start_digits)  # e.g. "01042022" — digits only, auto-advances DD→MM→YYYY
                page.wait_for_timeout(300)
                inputs[1].click()
                page.wait_for_timeout(200)
                page.keyboard.press("Home")
                page.wait_for_timeout(100)
                inputs[1].type(end_digits)
                page.wait_for_timeout(300)
                # Verify the fill worked (value should contain part of date)
                val0 = inputs[0].input_value()
                val1 = inputs[1].input_value()
                if val0 and val1:
                    filled_start = True
                    filled_end   = True
                    print(
                        f"[{label}] Filled date range {start_str} → {end_str} "
                        f"via '{sel}' (got '{val0}', '{val1}')"
                    )
                    break
                print(f"[{label}] Selector '{sel}' found {len(inputs)} inputs but fill failed (val0='{val0}', val1='{val1}')")
        except Exception as e:
            print(f"[{label}] Selector '{sel}' error: {e}")
            continue

    if not filled_start or not filled_end:
        print(f"[{label}] WARNING: Could not fill date inputs; trying keyboard approach")
        try:
            # Click body to ensure focus, then tab to first date field
            page.keyboard.press("Escape")
            page.wait_for_timeout(200)
            # Find first visible non-hidden input and type into it
            first_input = page.locator("input:not([aria-hidden='true'])").first
            first_input.click()
            page.wait_for_timeout(200)
            page.keyboard.press("Home")
            page.wait_for_timeout(100)
            first_input.type(start_digits)
            page.keyboard.press("Tab")
            page.wait_for_timeout(200)
            page.keyboard.type(end_digits)
        except Exception as e:
            print(f"[{label}] Keyboard fallback failed: {e}")

    # Step 3: click "Update Report" button (wait for it to become enabled after dates are filled)
    page.screenshot(path=f"/tmp/iex_{label.lower()}_step2b_before_update.png")
    try:
        update_btn = page.locator(
            "button:has-text('Update Report'), "
            "button:has-text('Apply'), "
            "button:has-text('Search'), "
            "button:has-text('Go')"
        ).first
        update_btn.wait_for(state="visible", timeout=5000)
        # Give MUI a moment to enable the button after date fill
        for _ in range(10):
            if update_btn.is_enabled():
                break
            page.wait_for_timeout(300)
        if update_btn.is_enabled():
            update_btn.click()
            print(f"[{label}] Clicked Update Report")
        else:
            print(f"[{label}] WARNING: Update Report still disabled after date fill — skipping click")
    except Exception as e:
        print(f"[{label}] WARNING: Update Report button not found: {e}")

    # Wait for table to refresh
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        pass
    page.wait_for_timeout(2000)
    page.screenshot(path=f"/tmp/iex_{label.lower()}_step3_table.png")
    return True


def _wait_for_table(page) -> None:
    try:
        page.wait_for_selector("table tbody tr", timeout=15000)
    except Exception:
        pass
    page.wait_for_timeout(1500)


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
    for i, h in enumerate(headers):
        if keyword.upper() in h.upper():
            return i
    return None


def _click_next_page(page, label: str) -> bool:
    """
    Click the pagination '>' next-page button.
    IEX uses Material-UI TablePagination — tries several aria-label variants.
    Returns True if the button was found, enabled, and clicked.
    """
    try:
        btn = page.locator(
            "button[aria-label='Go to next page'], "
            "button[aria-label='next page'], "
            "button[title='Next page'], "
            "button[title='Next']"
        ).first
        btn.wait_for(state="visible", timeout=3000)
        if not btn.is_enabled():
            print(f"[{label}] Next-page button disabled (last page)")
            return False
        btn.click()
        page.wait_for_timeout(1500)
        return True
    except Exception as e:
        print(f"[{label}] Next-page click failed: {e}")
        return False


# ── Core scrape: one chunk ────────────────────────────────────────────────────
#
# Instead of UI interaction (clicking dropdowns, filling date inputs), we
# navigate directly to the URL with query parameters.  Next.js SSR renders
# the table populated with the requested data — no dropdowns, no date pickers,
# no Update Report button.  Confirmed param names from browser DevTools:
#
#   interval=DAILY | HOURLY
#   dp=SELECT_RANGE | LAST_31_DAYS | LAST_8_DAYS
#   fromDate=DD-MM-YYYY   (only when dp=SELECT_RANGE)
#   toDate=DD-MM-YYYY
#   showGraph=false

def _chunk_url(base_url: str, interval: str, start: date, end: date) -> str:
    from_str = start.strftime("%d-%m-%Y")
    to_str   = end.strftime("%d-%m-%Y")
    return (
        f"{base_url}?interval={interval}&dp=SELECT_RANGE"
        f"&fromDate={from_str}&toDate={to_str}&showGraph=false"
    )


def _scrape_daily_chunk(
    url: str, interval: str, start: date, end: date, label: str
) -> tuple[list[str], list[list[str]]]:
    """
    Navigate directly to URL with interval/date query params.
    Returns (headers, rows).  No UI interaction — URL drives the page state.
    """
    from playwright.sync_api import sync_playwright

    full_url = _chunk_url(url, interval, start, end)
    print(f"[{label}] Fetching: {full_url}")

    with sync_playwright() as pw:
        browser, context = _make_browser_context(pw)
        page = context.new_page()
        try:
            page.goto(full_url, wait_until="domcontentloaded", timeout=90000)
            try:
                page.wait_for_load_state("networkidle", timeout=20000)
            except Exception:
                pass
            # Wait for table rows to render
            try:
                page.wait_for_selector("table tbody tr", timeout=20000)
            except Exception:
                pass
            page.wait_for_timeout(1500)

            headers, data = _parse_main_table(page)
            print(f"[{label}] {interval} {start}→{end}: headers={headers}, rows={len(data)}")

            if not headers or not data:
                page.screenshot(
                    path=f"/tmp/iex_{label.lower()}_backfill_{start}.png", full_page=True
                )
            return headers, data

        except Exception as e:
            print(f"[{label}] _scrape_daily_chunk exception: {e}")
            try:
                page.screenshot(
                    path=f"/tmp/iex_{label.lower()}_backfill_err_{start}.png", full_page=True
                )
            except Exception:
                pass
            return [], []
        finally:
            browser.close()


# ── High-level scrapers ───────────────────────────────────────────────────────

def scrape_daily_range(
    url: str, start: date, end: date, label: str
) -> dict[date, float]:
    """
    Scrape Daily MCP for all dates in [start, end], auto-chunking into ≤31-day windows.
    Returns {date: mcp_rs_per_unit}.
    """
    chunks = _date_chunks(start, end)
    print(f"[{label}] Daily scrape: {len(chunks)} chunk(s) for {start} → {end}")
    result: dict[date, float] = {}

    for chunk_start, chunk_end in chunks:
        headers, data = _scrape_daily_chunk(
            url, "DAILY", chunk_start, chunk_end, label
        )
        if not headers or not data:
            print(f"[{label}] No data for chunk {chunk_start}→{chunk_end}")
            continue

        date_col = _col_index(headers, "Date")
        mcp_col  = _col_index(headers, "MCP")
        if date_col is None or mcp_col is None:
            print(f"[{label}] Missing Date/MCP cols: {headers}")
            continue

        # Accumulate all MCP values per date, then average (table has multiple rows/day)
        mcps_by_date: defaultdict[date, list[float]] = defaultdict(list)
        for row in data:
            if max(date_col, mcp_col) >= len(row):
                continue
            d   = _parse_iex_date(row[date_col])
            mcp = _parse_float(row[mcp_col])
            if d is None or mcp is None:
                continue
            if not (chunk_start <= d <= chunk_end):
                continue
            mcps_by_date[d].append(mcp / 1000)

        new_dates = 0
        for d, mcps in mcps_by_date.items():
            result[d] = round(mean(mcps), 4)
            new_dates += 1
        print(f"[{label}] Chunk {chunk_start}→{chunk_end}: got {new_dates} new dates")
        time.sleep(2)  # be polite between chunks

    return result


def _scrape_hourly_chunk_paginated(
    url: str, start: date, end: date, label: str
) -> dict[date, tuple[float | None, float | None]]:
    """
    Scrape hourly solar/nonsolar data for dates in [start, end] using UI interaction.

    IEX does NOT serve HOURLY data via URL params (dp=SELECT_RANGE returns empty).
    The working approach matches what a user does manually:
      1. Navigate to the market snapshot page
      2. Page loads with interval already set to HOURLY (via ?interval=HOURLY URL param)
      3. Open delivery period dropdown → select '-Select Range-'
      4. Fill From / To date inputs
      5. Click 'Update Report'
      6. Parse the resulting table (may be paginated — one day per page — or all
         on one non-paginated table depending on IEX rendering)

    Rows are accumulated grouped by date to handle both rendering modes.
    """
    from playwright.sync_api import sync_playwright

    result: dict[date, tuple[float | None, float | None]] = {}

    # Load page with HOURLY interval pre-selected via URL param, then use UI
    # to select the custom delivery period (dropdown → -Select Range- → fill dates).
    base_url = f"{url}?interval=HOURLY&showGraph=false"
    print(f"[{label}] Hourly UI chunk {start}→{end}")

    with sync_playwright() as pw:
        browser, context = _make_browser_context(pw)
        page = context.new_page()
        try:
            # 1. Load page — HOURLY interval is pre-selected by URL param
            page.goto(base_url, wait_until="domcontentloaded", timeout=90000)
            try:
                page.wait_for_load_state("networkidle", timeout=20000)
            except Exception:
                pass
            page.wait_for_selector("[role='combobox']", timeout=30000)
            page.wait_for_timeout(1500)
            print(f"[{label}] Loaded: {page.title()}")

            # 1b. Explicitly select "Hourly" interval from combobox[0]
            #     (URL param ?interval=HOURLY is unreliable — page often defaults to 15-Min-Block)
            _click_dropdown_and_select(page, 0, "Hourly", label)
            page.wait_for_timeout(1000)

            # 2. Select custom date range via the delivery period dropdown
            ok = _set_custom_date_range(page, start, end, label)
            if not ok:
                print(f"[{label}] Could not set custom date range for {start}→{end}")
                try:
                    page.screenshot(
                        path=f"/tmp/iex_{label.lower()}_hourly_norange_{start}.png",
                        full_page=True,
                    )
                except Exception:
                    pass
                return {}

            # 3. Wait for the table to refresh with requested data
            try:
                page.wait_for_selector("table tbody tr", timeout=20000)
            except Exception:
                pass
            page.wait_for_timeout(1500)

            # 4. Parse table — accumulate rows grouped by date
            #    Works for both paginated (one day/page) and non-paginated (all rows)
            solar_by_date:    defaultdict[date, list[float]] = defaultdict(list)
            nonsolar_by_date: defaultdict[date, list[float]] = defaultdict(list)
            page_num = 0

            while True:
                page_num += 1
                headers, data = _parse_main_table(page)

                date_col = _col_index(headers, "Date")
                hour_col = next(
                    (i for i, h in enumerate(headers) if h.strip().lower() == "hour"),
                    None,
                )
                mcp_col = _col_index(headers, "MCP")

                if date_col is None or hour_col is None or mcp_col is None:
                    print(f"[{label}] Hourly page {page_num}: missing cols {headers}")
                    if page_num == 1:
                        try:
                            page.screenshot(
                                path=f"/tmp/iex_{label.lower()}_hourly_nocols_{start}.png",
                                full_page=True,
                            )
                        except Exception:
                            pass
                    break

                rows_this_page = 0
                for row in data:
                    if max(date_col, hour_col, mcp_col) >= len(row):
                        continue
                    d_str = row[date_col].strip()
                    if not d_str:
                        continue
                    d = _parse_iex_date(d_str)
                    if d is None or not (start <= d <= end):
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
                        solar_by_date[d].append(mcp_unit)
                    elif hour in NONSOLAR_HOURS:
                        nonsolar_by_date[d].append(mcp_unit)
                    rows_this_page += 1

                dates_seen = sorted(set(solar_by_date) | set(nonsolar_by_date))
                print(
                    f"[{label}] Hourly page {page_num}: {rows_this_page} rows, "
                    f"{len(dates_seen)} dates so far "
                    f"({dates_seen[0] if dates_seen else '?'} … "
                    f"{dates_seen[-1] if dates_seen else '?'})"
                )

                if not _click_next_page(page, label):
                    break  # Last page or non-paginated table

            # 5. Compute per-date averages from all accumulated MCPs
            for d in set(solar_by_date) | set(nonsolar_by_date):
                result[d] = (
                    round(mean(solar_by_date[d]),    4) if solar_by_date[d]    else None,
                    round(mean(nonsolar_by_date[d]), 4) if nonsolar_by_date[d] else None,
                )

        except Exception as e:
            print(f"[{label}] _scrape_hourly_chunk_paginated exception: {e}")
            try:
                page.screenshot(
                    path=f"/tmp/iex_{label.lower()}_hourly_err_{start}.png",
                    full_page=True,
                )
            except Exception:
                pass
        finally:
            browser.close()

    print(f"[{label}] Hourly chunk {start}→{end}: {len(result)} dates collected")
    return result


def scrape_hourly_range(
    url: str, start: date, end: date, label: str
) -> dict[date, tuple[float | None, float | None]]:
    """
    Scrape Hourly data for [start, end], return {date: (solar_avg, nonsolar_avg)}.
    Auto-chunks into ≤31-day windows; each chunk navigates paginated pages.
    """
    chunks = _date_chunks(start, end)
    print(f"[{label}] Hourly scrape: {len(chunks)} chunk(s) for {start} → {end}")
    result: dict[date, tuple[float | None, float | None]] = {}

    for chunk_start, chunk_end in chunks:
        chunk_result = _scrape_hourly_chunk_paginated(url, chunk_start, chunk_end, label)
        result.update(chunk_result)
        time.sleep(2)  # be polite between chunks

    return result


# ── Backfill logic ────────────────────────────────────────────────────────────

def backfill_dam(start: date, end: date) -> int:
    csv_path = CSV_PATHS["dam"]
    rows     = _read_csv(csv_path)
    existing = _existing_dates(rows)

    daily = scrape_daily_range(IEX_DAM_URL, start, end, "DAM")
    if not daily:
        print("[DAM] No data scraped.")
        return 0

    missing = {d: v for d, v in daily.items() if d not in existing}
    print(f"[DAM] Scraped {len(daily)} dates, {len(missing)} missing from CSV")
    if not missing:
        print("[DAM] Nothing to backfill.")
        return 0

    new_rows = {d: [_format_date_csv(d), v, "", ""] for d, v in missing.items()}
    _write_csv(csv_path, _merge_rows(rows, new_rows))
    print(f"[DAM] Added: {sorted(_format_date_csv(d) for d in missing)}")
    return len(missing)


def backfill_rtm(start: date, end: date) -> int:
    """
    Backfill RTM data for [start, end].

    - Adds rows for dates not yet in the CSV (daily + hourly).
    - Fills empty solar/nonsolar cells for dates that already exist
      in the CSV but are missing those values (empty string or absent).
    - Never overwrites a cell that already has a value.
    """
    csv_path = CSV_PATHS["rtm"]
    rows     = _read_csv(csv_path)
    existing = _existing_dates(rows)

    # Dates in range that need solar/nonsolar filled (empty cells)
    needs_solar: set[date] = set()
    for row in rows:
        if not row or row[0].strip().lower().startswith("date"):
            continue
        d = _parse_csv_date(row[0])
        if d and start <= d <= end:
            sol = row[2].strip() if len(row) > 2 else ""
            nos = row[3].strip() if len(row) > 3 else ""
            if not sol or not nos:
                needs_solar.add(d)

    missing = {d: v for d, v in
               scrape_daily_range(IEX_RTM_URL, start, end, "RTM").items()
               if d not in existing}

    if not missing and not needs_solar:
        print("[RTM] Nothing to backfill.")
        return 0

    # Only scrape hourly data if we actually need it
    hourly_dates_needed = set(missing.keys()) | needs_solar
    if hourly_dates_needed:
        hourly = scrape_hourly_range(IEX_RTM_URL, start, end, "RTM")
    else:
        hourly = {}

    # Build new rows for missing dates
    new_rows: dict[date, list] = {}
    for d, rtm_price in missing.items():
        sol, nos = hourly.get(d, (None, None))
        new_rows[d] = [
            _format_date_csv(d),
            rtm_price,
            sol if sol is not None else "",
            nos if nos is not None else "",
        ]

    # Fill empty solar/nonsolar cells in existing rows
    filled = 0
    updated_rows = [list(r) for r in rows]
    for i, row in enumerate(updated_rows):
        if not row or row[0].strip().lower().startswith("date"):
            continue
        d = _parse_csv_date(row[0])
        if d not in needs_solar or d not in hourly:
            continue
        # Ensure row has 4 columns
        while len(updated_rows[i]) < 4:
            updated_rows[i].append("")
        sol, nos = hourly[d]
        if not updated_rows[i][2].strip() and sol is not None:
            updated_rows[i][2] = str(sol)
            filled += 1
        if not updated_rows[i][3].strip() and nos is not None:
            updated_rows[i][3] = str(nos)

    _write_csv(csv_path, _merge_rows(updated_rows, new_rows))
    print(f"[RTM] Added {len(missing)} new rows, filled solar/nonsolar for {filled} existing rows")
    return len(missing) + filled


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill missing IEX RTM/DAM data")
    parser.add_argument(
        "--market", choices=["rtm", "dam", "both"], default="both",
    )
    parser.add_argument(
        "--start-date",
        help="Start date YYYY-MM-DD (default: 31 days ago)",
    )
    parser.add_argument(
        "--end-date",
        help="End date YYYY-MM-DD (default: yesterday)",
    )
    args = parser.parse_args()

    yesterday = date.today() - timedelta(days=1)

    end_date = (
        datetime.strptime(args.end_date, "%Y-%m-%d").date()
        if args.end_date else yesterday
    )
    start_date = (
        datetime.strptime(args.start_date, "%Y-%m-%d").date()
        if args.start_date else end_date - timedelta(days=30)
    )

    print(f"Backfill: market={args.market}, range={start_date} → {end_date}")
    chunks = _date_chunks(start_date, end_date)
    print(f"Will process {len(chunks)} chunk(s) of ≤{MAX_CHUNK_DAYS} days each")

    total = 0
    if args.market in ("dam", "both"):
        total += backfill_dam(start_date, end_date)
    if args.market in ("rtm", "both"):
        total += backfill_rtm(start_date, end_date)

    print(f"\nBackfill complete. Total rows added/fixed: {total}")
    sys.exit(0)
