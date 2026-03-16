"""
Scrape IEX Day-Ahead Market (DAM) data via Playwright UI simulation.

Usage:
  python scrape_iex_dam.py                   # yesterday's finalized data (nightly cron)
  python scrape_iex_dam.py --period today    # today's live partial data (hourly cron)

Column written to DAM Prices.csv:
  Date, DAM price (daily avg MCP Rs/Unit)

Strategy:
  - Navigate to IEX DAM page
  - Click "Daily" interval tab → select delivery period → parse HTML table → MCP ÷ 1000
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
    """Replace existing row for target_date, or append if not found."""
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
    """Click an interval tab then select the delivery period from the dropdown."""
    tab_selector = (
        f"button:has-text('{interval}'), "
        f"[role='tab']:has-text('{interval}')"
    )
    page.wait_for_selector(tab_selector, timeout=30000)
    page.locator(tab_selector).first.click()
    page.wait_for_timeout(1500)

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


# ── Fetch function ────────────────────────────────────────────────────────────

def fetch_dam_daily(period: str) -> float | None:
    """Return daily avg DAM MCP in Rs/Unit (MCP Rs/MWh ÷ 1000)."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("[DAM] Playwright not installed.")
        return None

    print(f"[DAM] Fetching Daily tab, period='{period}'...")
    with sync_playwright() as pw:
        browser, context = _make_browser_context(pw)
        page = context.new_page()
        try:
            page.goto(IEX_DAM_URL, wait_until="domcontentloaded", timeout=90000)
            _select_interval_and_period(page, "Daily", period)
            headers, data = _parse_table(page)
            print(f"[DAM] Daily: headers={headers}, rows={len(data)}")
            mcp_col = _mcp_col_index(headers)
            if mcp_col is None:
                print("[DAM] ERROR: MCP column not found in Daily table.")
                return None
            mcps = []
            for row in data:
                if mcp_col < len(row):
                    v = _parse_float(row[mcp_col])
                    if v is not None:
                        mcps.append(v)
            if not mcps:
                print("[DAM] No valid MCP values in Daily table.")
                return None
            avg = round(mean(mcps) / 1000, 4)
            print(f"[DAM] Daily avg MCP: {avg} Rs/Unit (n={len(mcps)})")
            return avg
        except Exception as e:
            print(f"[DAM] Daily fetch exception: {e}")
        finally:
            browser.close()
    return None


# ── Main ──────────────────────────────────────────────────────────────────────

def scrape_dam(target_date: date, period_label: str) -> bool:
    """
    period_label: "Yesterday" → append (skip if already present)
                  "Today"     → upsert (overwrite today's row each hour)
    """
    csv_path = CSV_PATHS["dam"]
    rows = _read_csv(csv_path)

    if period_label.lower() == "yesterday":
        last = _last_data_date(rows)
        if last and last >= target_date:
            print(f"[DAM] Data for {target_date} already present. Skipping.")
            return True

    print(f"[DAM] Scraping period='{period_label}' for date={target_date}...")

    dam_price = fetch_dam_daily(period_label)

    if dam_price is None:
        print(f"[DAM] ERROR: Could not get daily MCP for {target_date}.")
        return False

    new_row = [_format_date(target_date), dam_price, "", ""]
    print(f"[DAM] Row to write: {new_row}")

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
        help="Delivery period: 'yesterday' (nightly, default) or 'today' (hourly live)",
    )
    args = parser.parse_args()

    if args.period == "yesterday":
        target  = date.today() - timedelta(days=1)
        p_label = "Yesterday"
    else:
        target  = date.today()
        p_label = "Today"

    success = scrape_dam(target, p_label)
    sys.exit(0 if success else 1)
