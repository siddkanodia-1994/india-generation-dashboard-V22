"""
Scrape IEX Day-Ahead Market (DAM) data and append to DAM Prices.csv.

Column written: Date, DAM price (daily weighted avg MCP in Rs/Unit)

Strategy:
  1. Try IEX REST/JSON API endpoint directly.
  2. Fall back to Playwright headless browser if blocked.
"""

import csv
import re
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

    url = "https://www.iexindia.com/market-data/day-ahead-market/market-snapshot"
    intercepted_responses: list[dict] = []

    def handle_response(response):
        ct = response.headers.get("content-type", "")
        if "json" in ct or "javascript" in ct:
            try:
                body = response.json()
                intercepted_responses.append({"url": response.url, "body": body})
            except Exception:
                pass

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            )
        )
        page = context.new_page()
        page.on("response", handle_response)
        page.goto(url, wait_until="networkidle", timeout=90000)
        page.wait_for_timeout(5000)
        html_content = page.content()
        browser.close()

    # 1. Parse intercepted JSON
    for item in intercepted_responses:
        body = item["body"]
        if not isinstance(body, dict):
            continue
        for key in ("WeightedAvgMCP", "WAMCP", "AvgMCP", "MCP"):
            if key in body and body[key]:
                try:
                    return round(float(body[key]), 2)
                except Exception:
                    pass
        data = (body.get("Data") or body.get("data") or
                body.get("result") or body.get("Result") or [])
        if isinstance(data, list) and len(data) >= 20:
            prices = [float(r.get("MCP") or r.get("Price") or 0) for r in data]
            valid = [p for p in prices if p > 0]
            if valid:
                return round(mean(valid), 2)

    # 2. DOM fallback
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html_content, "lxml")
    text = soup.get_text(" ")
    for pat in [
        r"Weighted\s+Avg(?:erage)?\s+MCP[:\s]+(\d+\.?\d*)",
        r"WAMCP[:\s]+(\d+\.?\d*)",
        r"Avg(?:erage)?\s+(?:DAM\s+)?(?:Price|MCP)[:\s]+(\d+\.?\d*)",
    ]:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            return round(float(m.group(1)), 2)

    print(f"[DAM] Playwright: no data found. Intercepted {len(intercepted_responses)} JSON responses.")
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
