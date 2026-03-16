"""
Scrape IEX Day-Ahead Market (DAM) data via Playwright URL navigation.

Usage:
  python scrape_iex_dam.py                   # yesterday's finalized data (nightly cron)
  python scrape_iex_dam.py --period today    # today's live partial data (hourly cron)

Column written to DAM Prices.csv:
  Date, DAM price (daily avg MCP Rs/Unit)

URL param approach (confirmed from browser DevTools):
  ?interval=DAILY&dp=LAST_8_DAYS&showGraph=false
  Table columns: Date, Hour, Time Block, ..., MCP (Rs/MWh)
  Multiple rows per day (15-min blocks) — average MCP for target date ÷ 1000
"""

import argparse
import csv
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from statistics import mean

sys.path.insert(0, str(Path(__file__).parent))
from config import CSV_PATHS

IEX_DAM_URL = "https://www.iexindia.com/market-data/day-ahead-market/market-snapshot"


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
            print(f"[DAM] Updated existing row for {target_str}")
            return rows
    rows.append(new_row)
    print(f"[DAM] Appended new row for {target_str}")
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
        print(f"[DAM] [{label}] title='{page.title()}'")
        body = page.inner_text("body")[:300].replace("\n", " ")
        print(f"[DAM] [{label}] body='{body}'")
        page.screenshot(path=f"/tmp/iex_dam_{label}.png", full_page=True)
    except Exception as e:
        print(f"[DAM] [{label}] debug error: {e}")


def _navigate(page, url: str) -> None:
    """Load page and wait for the Interval combobox to appear (React hydrated)."""
    page.goto(url, wait_until="domcontentloaded", timeout=90000)
    try:
        page.wait_for_load_state("networkidle", timeout=20000)
    except Exception:
        pass
    page.wait_for_selector("[role='combobox']", timeout=30000)
    page.wait_for_timeout(1000)
    _debug_page(page, "after_load")


def _click_dropdown_and_select(page, combo_index: int, option_text: str) -> bool:
    """Click the nth combobox and select an option by text."""
    try:
        combos = page.locator("[role='combobox']").all()
        print(f"[DAM] Found {len(combos)} comboboxes")
        if combo_index >= len(combos):
            print(f"[DAM] No combobox at index {combo_index}")
            return False
        combos[combo_index].click()
        page.wait_for_timeout(600)
        opt = page.locator(
            f"[role='option']:has-text('{option_text}'), "
            f"li:has-text('{option_text}')"
        ).first
        opt.wait_for(timeout=5000)
        opt.click()
        print(f"[DAM] Selected '{option_text}' from combobox[{combo_index}]")
        page.wait_for_timeout(500)
        return True
    except Exception as e:
        print(f"[DAM] Dropdown select failed (combo={combo_index}, option='{option_text}'): {e}")
        return False


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
        print(f"[DAM] Table parse error: {e}")
        return [], []


def _mcp_col_index(headers: list[str]) -> int | None:
    for i, h in enumerate(headers):
        if "MCP" in h.upper():
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


# ── Fetch ─────────────────────────────────────────────────────────────────────

def fetch_dam_daily(target_date: date) -> float | None:
    """
    Navigate directly to IEX DAM URL with interval=DAILY&dp=LAST_8_DAYS,
    filter rows matching target_date, return mean MCP ÷ 1000 (Rs/Unit).

    Using URL navigation avoids dropdown interaction issues: when 'Daily'
    interval is selected, delivery period options change to Last 8/31 Days
    and -Select Range- only — 'Today'/'Yesterday' disappear, causing silent
    fallback to multi-day averages.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("[DAM] Playwright not installed.")
        return None

    url = (
        f"{IEX_DAM_URL}?interval=DAILY&dp=LAST_8_DAYS&showGraph=false"
    )
    print(f"[DAM] fetch_dam_daily target={target_date}, url={url}")

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
            print(f"[DAM] headers={headers}, total rows={len(data)}")

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

            print(f"[DAM] {target_date}: {len(mcps)} blocks with MCP data")
            if not mcps:
                _debug_page(page, "daily_empty_mcp")
                return None

            avg = round(mean(mcps) / 1000, 4)
            print(f"[DAM] avg MCP for {target_date}: {avg} Rs/Unit")
            return avg
        except Exception as e:
            print(f"[DAM] fetch_dam_daily exception: {e}")
            try:
                _debug_page(page, "daily_exception")
            except Exception:
                pass
        finally:
            browser.close()
    return None


# ── Main ──────────────────────────────────────────────────────────────────────

def scrape_dam(target_date: date, period_label: str) -> bool:
    csv_path = CSV_PATHS["dam"]
    rows = _read_csv(csv_path)

    if period_label.lower() == "yesterday":
        last = _last_data_date(rows)
        if last and last >= target_date:
            print(f"[DAM] Data for {target_date} already present. Skipping.")
            return True

    print(f"[DAM] Scraping period='{period_label}' for date={target_date}...")

    dam_price = fetch_dam_daily(target_date)

    if dam_price is None:
        print(f"[DAM] ERROR: Could not get daily MCP for {target_date}.")
        return False

    new_row = [_format_date(target_date), dam_price, "", ""]
    print(f"[DAM] Writing row: {new_row}")

    if period_label.lower() == "today":
        rows = _upsert_row(rows, target_date, new_row)
        _write_csv(csv_path, rows)
    else:
        with open(csv_path, "a", newline="") as f:
            csv.writer(f).writerow(new_row)

    print(f"[DAM] Done ({period_label}).")
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scrape IEX DAM prices")
    parser.add_argument(
        "--period",
        choices=["yesterday", "today"],
        default="yesterday",
        help="'yesterday' (nightly) or 'today' (hourly live)",
    )
    args = parser.parse_args()

    from datetime import datetime, timezone
    IST = timezone(timedelta(hours=5, minutes=30))

    if args.period == "yesterday":
        target  = datetime.now(IST).date() - timedelta(days=1)
        p_label = "Yesterday"
    else:
        target  = datetime.now(IST).date()
        p_label = "Today"

    success = scrape_dam(target, p_label)
    sys.exit(0 if success else 1)
