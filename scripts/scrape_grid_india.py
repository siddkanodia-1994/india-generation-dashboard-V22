"""
Scrape Grid India Daily PSP Report (Excel) and append to:
  - supply.csv        : Total energy met (MU)      — MOP_E!H8  (row: "Energy Met (MU)")
  - Peak Demand.csv   : Peak demand met (GW)        — MOP_E!H13 (row: "Maximum Demand Met…"), /1000
  - generation.csv    : Total generation, Thermal (derived), Renewable — MOP_E section G

The Excel file is published on grid-india.in for the *previous* day.
The DATA date is embedded in the Excel filename (not the upload/listing date).

Run pattern: idempotent, exits 0 on success OR if data already present, exits 2 if Excel
not yet published (GitHub Actions workflow retries every 30 min from 9am–11am IST).

Usage:
  python scrape_grid_india.py                  # yesterday (IST)
  python scrape_grid_india.py --date 2026-03-17
"""

import argparse
import csv
import io
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent))
from config import CSV_PATHS, GRID_INDIA_REPORTS_URL, GRID_INDIA_PDF_BASE

IST = timezone(timedelta(hours=5, minutes=30))

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
}


# ── CSV helpers ────────────────────────────────────────────────────────────────

def _last_date_in_csv(path: str):
    p = Path(path)
    if not p.exists():
        return None
    with open(p, newline="") as f:
        rows = list(csv.reader(f))
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


def _format_date(d: date) -> str:
    return d.strftime("%d/%m/%y")


def _append_csv(path: str, row: list) -> None:
    with open(path, "a", newline="") as f:
        csv.writer(f).writerow(row)


# ── Excel URL discovery via Playwright ────────────────────────────────────────

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


def _date_variants(d: date) -> list:
    return [
        d.strftime("%d_%m_%Y"),   # 17_03_2026
        d.strftime("%d%m%Y"),     # 17032026
        d.strftime("%d-%m-%Y"),   # 17-03-2026
        d.strftime("%d.%m.%Y"),   # 17.03.2026
        d.strftime("%d_%m_%y"),   # 17_03_26
        d.strftime("%d%m%y"),     # 170326
    ]


def _find_excel_url(target_date: date):
    """
    Use Playwright to render the Grid India Daily PSP Report page and find
    the Excel download link for target_date. Returns full URL or None.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("[GRID] Playwright not installed.")
        return None

    variants = _date_variants(target_date)

    print(f"[GRID] Loading page: {GRID_INDIA_REPORTS_URL}")
    with sync_playwright() as pw:
        browser, context = _make_browser_context(pw)
        page = context.new_page()
        try:
            page.goto(GRID_INDIA_REPORTS_URL, wait_until="domcontentloaded", timeout=60000)
            # Wait for network to settle (React hydration)
            try:
                page.wait_for_load_state("networkidle", timeout=20000)
            except Exception:
                pass
            # Try to wait for any Excel/xls links to appear
            try:
                page.wait_for_selector("a[href*='.xls']", timeout=20000)
            except Exception:
                pass
            page.wait_for_timeout(2000)

            # Extract all hrefs from rendered DOM
            hrefs = page.eval_on_selector_all(
                "a[href]",
                "els => els.map(e => e.getAttribute('href'))"
            )
            print(f"[GRID] Found {len(hrefs)} links on rendered page")
        except Exception as e:
            print(f"[GRID] Playwright page load failed: {e}")
            hrefs = []
        finally:
            browser.close()

    # Filter for Excel links matching the target date
    for href in hrefs:
        if not href:
            continue
        lower = href.lower()
        if not (lower.endswith(".xlsx") or lower.endswith(".xls")):
            continue
        for v in variants:
            if v in href:
                full = href if href.startswith("http") else GRID_INDIA_PDF_BASE + href
                print(f"[GRID] Found Excel: {full}")
                return full

    # Fallback: try common direct URL patterns (may work even on SPA sites)
    print("[GRID] No Excel link found in rendered DOM, trying direct URL patterns...")
    for pattern in [
        f"/NLDC/NLDC_Daily_Report/PSP_{target_date.strftime('%d_%m_%Y')}.xlsx",
        f"/uploads/PSP_{target_date.strftime('%d_%m_%Y')}.xlsx",
        f"/reports/daily-psp-report/PSP_{target_date.strftime('%d_%m_%Y')}.xlsx",
        f"/assets/PSP_{target_date.strftime('%d_%m_%Y')}.xlsx",
    ]:
        url = GRID_INDIA_PDF_BASE + pattern
        try:
            resp = requests.head(url, headers=HEADERS, timeout=10, allow_redirects=True)
            if resp.status_code == 200:
                print(f"[GRID] Direct URL found: {url}")
                return url
        except Exception:
            continue

    return None


# ── Excel parsing helpers ──────────────────────────────────────────────────────

def _find_row(ws, keyword: str, start: int = 1, max_scan: int = 200):
    """
    Scan column A from start to start+max_scan for a cell whose string value
    contains keyword (case-insensitive). Returns the row number or None.
    """
    kw = keyword.lower()
    end = min(start + max_scan, ws.max_row + 1)
    for r in range(start, end):
        cell = ws.cell(row=r, column=1)
        val = str(cell.value or "").strip().lower()
        if kw in val:
            return r
    return None


def _find_row_after(ws, keyword: str, start: int, max_scan: int = 20):
    """
    Like _find_row but starts at start+1 (for anchored section searches).
    """
    return _find_row(ws, keyword, start=start + 1, max_scan=max_scan)


def _cell_float(ws, row: int, col: int):
    """Return float value of cell or None."""
    if row is None:
        return None
    try:
        v = ws.cell(row=row, column=col).value
        if v is None:
            return None
        return float(str(v).replace(",", "").strip())
    except (ValueError, TypeError):
        return None


def _parse_mop_e(wb) -> dict:
    """
    Parse the MOP_E sheet and return a dict with keys:
      supply_mu, peak_demand_gw, total_gen_mu, renewable_mu, thermal_mu
    Missing values are None.
    """
    result = {}

    if "MOP_E" not in wb.sheetnames:
        print(f"[GRID] Sheet 'MOP_E' not found. Available: {wb.sheetnames}")
        return result

    ws = wb["MOP_E"]
    H = 8  # column index for "All India" / Total column

    # ── Supply (Energy Met MU) ────────────────────────────────────────────────
    r = _find_row(ws, "energy met")
    if r:
        v = _cell_float(ws, r, H)
        if v is not None:
            result["supply_mu"] = round(v, 0)
            print(f"[GRID] Supply (row {r}): {result['supply_mu']} MU")
        else:
            print(f"[GRID] WARNING: 'Energy Met' found at row {r} but H{r} is empty/non-numeric")
    else:
        print("[GRID] WARNING: 'Energy Met' header not found in MOP_E column A")

    # ── Peak Demand (MW → GW) ─────────────────────────────────────────────────
    r = _find_row(ws, "maximum demand met")
    if r:
        v = _cell_float(ws, r, H)
        if v is not None:
            result["peak_demand_gw"] = round(v / 1000, 2)
            print(f"[GRID] Peak Demand (row {r}): {v} MW → {result['peak_demand_gw']} GW")
        else:
            print(f"[GRID] WARNING: 'Maximum Demand Met' found at row {r} but H{r} is empty")
    else:
        print("[GRID] WARNING: 'Maximum Demand Met' header not found in MOP_E column A")

    # ── Total Generation ──────────────────────────────────────────────────────
    # Anchored: find the section header first, then "Total" within 20 rows
    section_row = _find_row(ws, "G. Sourcewise generation (Gross)")
    if section_row is None:
        section_row = _find_row(ws, "Sourcewise generation")  # fallback partial
    if section_row:
        total_row = _find_row_after(ws, "Total", start=section_row, max_scan=20)
        if total_row:
            v = _cell_float(ws, total_row, H)
            if v is not None:
                result["total_gen_mu"] = round(v, 0)
                print(f"[GRID] Total Generation (row {total_row}): {result['total_gen_mu']} MU")
            else:
                print(f"[GRID] WARNING: Total row {total_row} found but H value is empty")
        else:
            print(f"[GRID] WARNING: 'Total' not found within 20 rows of section row {section_row}")
    else:
        print("[GRID] WARNING: 'G. Sourcewise generation' section not found")

    # ── Renewable (RES) ───────────────────────────────────────────────────────
    r = _find_row(ws, "RES (Wind, Solar, Biomass")
    if r:
        v = _cell_float(ws, r, H)
        if v is not None:
            result["renewable_mu"] = round(v, 0)
            print(f"[GRID] Renewable (row {r}): {result['renewable_mu']} MU")
        else:
            print(f"[GRID] WARNING: RES row {r} found but H value is empty")
    else:
        print("[GRID] WARNING: 'RES (Wind, Solar, Biomass' row not found in MOP_E")

    # ── Thermal = Total − Renewable (derived, balancing figure) ──────────────
    if "total_gen_mu" in result and "renewable_mu" in result:
        result["thermal_mu"] = round(result["total_gen_mu"] - result["renewable_mu"], 0)
        print(f"[GRID] Thermal (derived): {result['thermal_mu']} MU")

    return result


# ── Main ──────────────────────────────────────────────────────────────────────

def scrape_grid_india(target_date=None) -> bool:
    """
    Returns True on success. Raises SystemExit(2) if Excel not yet published.
    """
    if target_date is None:
        target_date = datetime.now(IST).date() - timedelta(days=1)

    # Idempotency check on supply.csv
    last = _last_date_in_csv(CSV_PATHS["supply"])
    if last and last >= target_date:
        print(f"[GRID] Data for {target_date} already present. Skipping.")
        return True

    print(f"[GRID] Looking for Excel file for {target_date}...")

    excel_url = _find_excel_url(target_date)
    if excel_url is None:
        print(f"[GRID] Excel not yet available for {target_date}. Will retry.")
        sys.exit(2)  # GitHub Actions retry signal

    print(f"[GRID] Downloading: {excel_url}")
    try:
        r = requests.get(excel_url, headers=HEADERS, timeout=60)
        r.raise_for_status()
        excel_bytes = r.content
    except Exception as e:
        print(f"[GRID] Failed to download Excel: {e}")
        return False

    try:
        from openpyxl import load_workbook
        wb = load_workbook(io.BytesIO(excel_bytes), data_only=True)
    except Exception as e:
        print(f"[GRID] Failed to open workbook: {e}")
        return False

    data = _parse_mop_e(wb)
    if not data:
        print("[GRID] ERROR: Could not extract any data from MOP_E sheet.")
        return False

    date_str = _format_date(target_date)
    wrote_any = False

    # Write supply.csv
    if "supply_mu" in data:
        _append_csv(CSV_PATHS["supply"], [date_str, data["supply_mu"]])
        wrote_any = True
    else:
        print("[GRID] WARNING: supply_mu missing — not writing to supply.csv")

    # Write Peak Demand.csv
    if "peak_demand_gw" in data:
        _append_csv(CSV_PATHS["demand"], [date_str, data["peak_demand_gw"]])
        wrote_any = True
    else:
        print("[GRID] WARNING: peak_demand_gw missing — not writing to Peak Demand.csv")

    # Write generation.csv (Date, Total, Coal/Thermal, Renewable)
    if "total_gen_mu" in data:
        thermal  = data.get("thermal_mu", "")
        renewabl = data.get("renewable_mu", "")
        _append_csv(CSV_PATHS["generation"], [date_str, data["total_gen_mu"], thermal, renewabl])
        wrote_any = True
    else:
        print("[GRID] WARNING: total_gen_mu missing — not writing to generation.csv")

    if wrote_any:
        print(f"[GRID] Done for {target_date}.")
        return True

    print("[GRID] ERROR: No CSV rows written.")
    return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", help="Target date YYYY-MM-DD (default: yesterday IST)")
    args = parser.parse_args()

    target = None
    if args.date:
        target = date.fromisoformat(args.date)

    success = scrape_grid_india(target)
    sys.exit(0 if success else 1)
