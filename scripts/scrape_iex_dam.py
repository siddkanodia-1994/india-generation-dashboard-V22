"""
Scrape IEX Day-Ahead Market (DAM) data and append to DAM Prices.csv.

Column written: Date, DAM price (daily weighted avg MCP in Rs/Unit)

Strategy:
  1. Try IEX REST/JSON API endpoint directly.
  2. Fall back to Playwright headless browser if blocked.
"""

import csv
import sys
from datetime import date, timedelta
from pathlib import Path
from statistics import mean

import requests

sys.path.insert(0, str(Path(__file__).parent))
from config import CSV_PATHS, IEX_DAM_SUMMARY_URL

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.iexindia.com/",
    "Accept": "application/json, text/javascript, */*",
}

SESSION = requests.Session()
SESSION.headers.update(HEADERS)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _last_date_in_csv(path: str) -> date | None:
    p = Path(path)
    if not p.exists():
        return None
    with open(p, newline="") as f:
        rows = list(csv.reader(f))
    data_rows = [r for r in rows if r and not r[0].startswith("Date")]
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


def _iex_date_param(d: date) -> str:
    return d.strftime("%d-%b-%Y")


# ── API approach ──────────────────────────────────────────────────────────────

def _fetch_dam_api(target_date: date) -> float | None:
    params = {"date": _iex_date_param(target_date)}
    try:
        r = SESSION.get(IEX_DAM_SUMMARY_URL, params=params, timeout=20)
        if r.status_code != 200:
            return None
        data = r.json()
        if isinstance(data, dict):
            for key in ("WeightedAvgMCP", "WAMCP", "AvgMCP", "MCP"):
                if key in data:
                    return round(float(data[key]), 2)
            inner = data.get("Data") or data.get("data") or []
            if inner and isinstance(inner, list):
                prices = [
                    float(row.get("MCP", 0) or row.get("Price", 0))
                    for row in inner
                    if row.get("MCP") or row.get("Price")
                ]
                if prices:
                    return round(mean(prices), 2)
        return None
    except Exception:
        return None


# ── Playwright fallback ───────────────────────────────────────────────────────

def _fetch_dam_via_playwright(target_date: date) -> float | None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("[DAM] Playwright not installed; cannot fall back.")
        return None

    url = (
        f"https://www.iexindia.com/market-data/day-ahead-market/market-snapshot"
        f"?date={_iex_date_param(target_date)}"
    )
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page()
        intercepted: list[dict] = []

        def handle_response(response):
            if "DAM" in response.url or "dam" in response.url.lower():
                try:
                    body = response.json()
                    intercepted.append(body)
                except Exception:
                    pass

        page.on("response", handle_response)
        page.goto(url, wait_until="networkidle", timeout=60000)
        page.wait_for_timeout(3000)
        browser.close()

    for body in intercepted:
        if isinstance(body, dict):
            for key in ("WeightedAvgMCP", "WAMCP", "AvgMCP"):
                if key in body:
                    return round(float(body[key]), 2)
            data = body.get("Data") or body.get("data") or []
            if isinstance(data, list) and len(data) >= 20:
                prices = [float(r.get("MCP") or r.get("Price") or 0) for r in data]
                return round(mean([p for p in prices if p > 0]), 2)
    return None


# ── Main logic ────────────────────────────────────────────────────────────────

def scrape_dam(target_date: date | None = None) -> bool:
    if target_date is None:
        target_date = date.today() - timedelta(days=1)

    csv_path = CSV_PATHS["dam"]

    last = _last_date_in_csv(csv_path)
    if last and last >= target_date:
        print(f"[DAM] Data for {target_date} already present. Skipping.")
        return True

    print(f"[DAM] Fetching data for {target_date}...")

    dam_price = _fetch_dam_api(target_date)

    if dam_price is None:
        print("[DAM] API failed; trying Playwright...")
        dam_price = _fetch_dam_via_playwright(target_date)

    if dam_price is None:
        print(f"[DAM] ERROR: Could not fetch DAM price for {target_date}.")
        return False

    row = [_format_date(target_date), dam_price, "", ""]
    print(f"[DAM] Writing: {row}")

    with open(csv_path, "a", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(row)

    print(f"[DAM] Done for {target_date}.")
    return True


if __name__ == "__main__":
    success = scrape_dam()
    sys.exit(0 if success else 1)
