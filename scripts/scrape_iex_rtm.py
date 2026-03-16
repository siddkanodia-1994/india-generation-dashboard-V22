"""
Scrape IEX Real-Time Market (RTM) data and append to RTM Prices.csv.

Columns written: Date, RTM price, Solar_Avg, NonSolar_Avg
  - RTM price   : daily weighted average MCP (Rs/Unit)
  - Solar_Avg   : average of 15-min block prices for 6am–6pm IST
  - NonSolar_Avg: average of 15-min block prices for 6pm–6am IST

Strategy:
  1. Try IEX REST/JSON API endpoints directly.
  2. If blocked (403/non-JSON), fall back to Playwright headless browser.
"""

import csv
import json
import re
import sys
import time
from datetime import date, timedelta
from pathlib import Path
from statistics import mean

import requests

sys.path.insert(0, str(Path(__file__).parent))
from config import (
    CSV_PATHS,
    IEX_RTM_SUMMARY_URL,
    IEX_RTM_HOURLY_URL,
    RTM_SOLAR_BLOCKS,
    RTM_NONSOLAR_BLOCKS,
)

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
    """Return the last date already present in the CSV, or None."""
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
    """IEX uses DD-MMM-YYYY format in query params."""
    return d.strftime("%d-%b-%Y")


# ── API approach ──────────────────────────────────────────────────────────────

def _fetch_rtm_summary_api(target_date: date) -> float | None:
    """Try to get the daily weighted avg MCP via the IEX market summary API."""
    params = {"date": _iex_date_param(target_date)}
    try:
        r = SESSION.get(IEX_RTM_SUMMARY_URL, params=params, timeout=20)
        if r.status_code != 200:
            return None
        data = r.json()
        # IEX typically returns {"Status": "Success", "Data": [...]}
        # Look for weighted average MCP field
        if isinstance(data, dict):
            for key in ("WeightedAvgMCP", "WAMCP", "AvgMCP", "MCP"):
                if key in data:
                    return float(data[key])
            # Dig into Data list
            inner = data.get("Data") or data.get("data") or []
            if inner and isinstance(inner, list):
                prices = [float(row.get("MCP", 0) or row.get("Price", 0))
                          for row in inner if row.get("MCP") or row.get("Price")]
                if prices:
                    return round(mean(prices), 2)
        return None
    except Exception:
        return None


def _fetch_rtm_hourly_api(target_date: date) -> list[float] | None:
    """
    Fetch 96 block prices for target_date.
    Returns a list of 96 floats (index 0 = block 1) or None on failure.
    """
    params = {"date": _iex_date_param(target_date)}
    try:
        r = SESSION.get(IEX_RTM_HOURLY_URL, params=params, timeout=20)
        if r.status_code != 200:
            return None
        data = r.json()
        blocks = data.get("Data") or data.get("data") or []
        if not blocks or len(blocks) < 90:
            return None
        prices = []
        for block in sorted(blocks, key=lambda x: int(x.get("BlockNo", x.get("Block", 0)))):
            val = block.get("MCP") or block.get("Price") or block.get("price") or 0
            prices.append(float(val))
        return prices if len(prices) >= 90 else None
    except Exception:
        return None


# ── Playwright fallback ───────────────────────────────────────────────────────

def _fetch_rtm_via_playwright(target_date: date) -> tuple[float | None, list[float] | None]:
    """
    Use Playwright to scrape IEX RTM market snapshot page.
    Intercepts all JSON API responses and also reads DOM table as fallback.
    Returns (daily_avg, [96 block prices]) or (None, None).
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("[RTM] Playwright not installed; cannot fall back.")
        return None, None

    date_str = _iex_date_param(target_date)
    url = f"https://www.iexindia.com/market-data/real-time-market/market-snapshot"

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

        # Navigate and wait for network to settle
        page.goto(url, wait_until="networkidle", timeout=90000)
        page.wait_for_timeout(5000)

        # Try selecting the date if the page has a date picker
        try:
            page.select_option("select[name*='date'], select[id*='date']", date_str)
            page.wait_for_timeout(3000)
        except Exception:
            pass

        # Extract from DOM: look for tables with price data
        html_content = page.content()
        browser.close()

    # 1. Parse intercepted JSON responses
    daily_avg = None
    blocks: list[float] | None = None

    for item in intercepted_responses:
        body = item["body"]
        if not isinstance(body, dict):
            continue
        # Check for block data list
        data = (body.get("Data") or body.get("data") or
                body.get("result") or body.get("Result") or [])
        if isinstance(data, list) and len(data) >= 90:
            prices = []
            for row in data:
                val = (row.get("MCP") or row.get("Price") or row.get("price") or
                       row.get("mcp") or row.get("BlockPrice") or 0)
                prices.append(float(val) if val else 0)
            valid = [p for p in prices if p > 0]
            if valid:
                blocks = prices
                daily_avg = round(mean(valid), 2)
                break
        # Check for scalar MCP
        for key in ("WeightedAvgMCP", "WAMCP", "AvgMCP", "MCP", "wamcp", "avgMCP"):
            if key in body and body[key]:
                try:
                    daily_avg = round(float(body[key]), 2)
                except Exception:
                    pass

    # 2. DOM fallback: parse HTML tables for MCP values
    if daily_avg is None:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html_content, "lxml")
        text = soup.get_text(" ")
        # Look for "Weighted Average MCP" or similar
        for pat in [
            r"Weighted\s+Avg(?:erage)?\s+MCP[:\s]+(\d+\.?\d*)",
            r"WAMCP[:\s]+(\d+\.?\d*)",
            r"Avg(?:erage)?\s+MCP[:\s]+(\d+\.?\d*)",
        ]:
            m = re.search(pat, text, re.IGNORECASE)
            if m:
                daily_avg = round(float(m.group(1)), 2)
                break

        # Try extracting block prices from a table
        if blocks is None:
            tables = soup.find_all("table")
            for table in tables:
                rows = table.find_all("tr")
                prices = []
                for row in rows:
                    cells = row.find_all("td")
                    for cell in cells:
                        txt = re.sub(r"[^\d.]", "", cell.get_text(strip=True))
                        try:
                            val = float(txt)
                            if 0.5 <= val <= 50:  # reasonable RTM price range
                                prices.append(val)
                        except Exception:
                            pass
                if len(prices) >= 90:
                    blocks = prices
                    if daily_avg is None:
                        daily_avg = round(mean(prices), 2)
                    break

    if daily_avg is None:
        print(f"[RTM] Playwright: no data found. Intercepted {len(intercepted_responses)} JSON responses.")

    return daily_avg, blocks


# ── Main logic ────────────────────────────────────────────────────────────────

def scrape_rtm(target_date: date | None = None) -> bool:
    """
    Scrape RTM data for target_date (defaults to yesterday).
    Appends a row to RTM Prices.csv.
    Returns True on success, False on failure.
    """
    if target_date is None:
        target_date = date.today() - timedelta(days=1)

    csv_path = CSV_PATHS["rtm"]

    # Idempotency check
    last = _last_date_in_csv(csv_path)
    if last and last >= target_date:
        print(f"[RTM] Data for {target_date} already present. Skipping.")
        return True

    print(f"[RTM] Fetching data for {target_date}...")

    # 1. Try API
    daily_avg = _fetch_rtm_summary_api(target_date)
    blocks    = _fetch_rtm_hourly_api(target_date)

    # 2. Fall back to Playwright if either is missing
    if daily_avg is None or blocks is None:
        print("[RTM] API incomplete; trying Playwright...")
        pw_avg, pw_blocks = _fetch_rtm_via_playwright(target_date)
        if daily_avg is None:
            daily_avg = pw_avg
        if blocks is None:
            blocks = pw_blocks

    if daily_avg is None:
        print(f"[RTM] ERROR: Could not fetch daily avg for {target_date}.")
        return False

    # Calculate solar / non-solar averages from block prices
    if blocks and len(blocks) >= 96:
        solar_prices    = [blocks[i - 1] for i in RTM_SOLAR_BLOCKS    if blocks[i - 1] > 0]
        nonsolar_prices = [blocks[i - 1] for i in RTM_NONSOLAR_BLOCKS if blocks[i - 1] > 0]
        solar_avg    = round(mean(solar_prices),    2) if solar_prices    else daily_avg
        nonsolar_avg = round(mean(nonsolar_prices), 2) if nonsolar_prices else daily_avg
    else:
        print("[RTM] WARNING: Block data unavailable; solar/non-solar avg set to daily avg.")
        solar_avg    = daily_avg
        nonsolar_avg = daily_avg

    row = [_format_date(target_date), daily_avg, solar_avg, nonsolar_avg]
    print(f"[RTM] Writing: {row}")

    with open(csv_path, "a", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(row)

    print(f"[RTM] Done for {target_date}.")
    return True


if __name__ == "__main__":
    success = scrape_rtm()
    sys.exit(0 if success else 1)
