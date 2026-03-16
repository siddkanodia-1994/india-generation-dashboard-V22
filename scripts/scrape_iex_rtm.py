"""
Scrape IEX Real-Time Market (RTM) data and append to RTM Prices.csv.

Columns written: Date, RTM price, Solar_Avg, NonSolar_Avg
  - RTM price   : daily weighted average MCP (Rs/Unit)
  - Solar_Avg   : average of 15-min block prices for 6am–6pm IST
  - NonSolar_Avg: average of 15-min block prices for 6pm–6am IST

Strategy:
  1. Try IEX internal API endpoints directly (used by their own website).
  2. If blocked, fall back to Playwright with stealth headers.
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
    RTM_SOLAR_BLOCKS,
    RTM_NONSOLAR_BLOCKS,
)

# IEX India internal API endpoints (used by their website frontend)
IEX_BASE = "https://www.iexindia.com"

# These are the actual XHR endpoints the IEX website frontend calls
IEX_RTM_ENDPOINTS = [
    f"{IEX_BASE}/Modules/MarketData/RTM/frmRTMMarketSnapshot.aspx/GetRTMMarketSummary",
    f"{IEX_BASE}/api/MarketData/RTM/GetRTMMarketSummary",
    f"{IEX_BASE}/api/rtm/summary",
    f"{IEX_BASE}/MarketData/RTM/GetMarketSummary",
]

IEX_RTM_BLOCK_ENDPOINTS = [
    f"{IEX_BASE}/Modules/MarketData/RTM/frmRTMMarketSnapshot.aspx/GetRTMBlockPrices",
    f"{IEX_BASE}/api/MarketData/RTM/GetRTMBlockPrices",
    f"{IEX_BASE}/api/rtm/blockprices",
]

# Simulate a real browser session
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": f"{IEX_BASE}/market-data/real-time-market/market-snapshot",
    "Origin": IEX_BASE,
    "Connection": "keep-alive",
}


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
    """IEX uses DD-MMM-YYYY format, e.g. 15-Mar-2026"""
    return d.strftime("%d-%b-%Y")


def _iex_date_param_slash(d: date) -> str:
    """Alternative format DD/MM/YYYY"""
    return d.strftime("%d/%m/%Y")


def _make_session() -> requests.Session:
    """Create a session that looks like a real browser, including visiting homepage first."""
    s = requests.Session()
    s.headers.update(BROWSER_HEADERS)
    # Visit homepage to get cookies
    try:
        s.get(IEX_BASE, timeout=15)
        time.sleep(1)
    except Exception:
        pass
    return s


# ── API approach ──────────────────────────────────────────────────────────────

def _try_endpoint(session: requests.Session, url: str, payload: dict) -> dict | None:
    """POST to an endpoint with JSON payload, return parsed JSON or None."""
    try:
        r = session.post(url, json=payload, timeout=20)
        if r.status_code == 200:
            data = r.json()
            # IEX ASP.NET endpoints wrap response in {"d": ...}
            if "d" in data:
                inner = data["d"]
                if isinstance(inner, str):
                    return json.loads(inner)
                return inner
            return data
    except Exception:
        pass

    # Also try GET
    try:
        params = {k: v for k, v in payload.items()}
        r = session.get(url, params=params, timeout=20)
        if r.status_code == 200:
            data = r.json()
            if "d" in data:
                inner = data["d"]
                if isinstance(inner, str):
                    return json.loads(inner)
                return inner
            return data
    except Exception:
        pass

    return None


def _fetch_rtm_api(target_date: date) -> tuple[float | None, list[float] | None]:
    """Try all known IEX API endpoints to get daily MCP and block prices."""
    session = _make_session()

    date_variants = [
        _iex_date_param(target_date),
        _iex_date_param_slash(target_date),
        target_date.strftime("%Y-%m-%d"),
    ]

    daily_avg = None
    blocks = None

    for date_str in date_variants:
        payload = {"date": date_str, "Date": date_str}

        # Try daily summary endpoints
        for endpoint in IEX_RTM_ENDPOINTS:
            result = _try_endpoint(session, endpoint, payload)
            if result is None:
                continue
            print(f"[RTM] Got response from {endpoint}")

            # Extract daily weighted avg MCP
            if isinstance(result, dict):
                for key in ("WeightedAvgMCP", "WAMCP", "AvgMCP", "MCP",
                            "wamcp", "avgMCP", "AvgPrice", "avgPrice"):
                    if key in result and result[key]:
                        try:
                            daily_avg = round(float(result[key]), 2)
                            break
                        except Exception:
                            pass
                # Also check nested Data
                data = result.get("Data") or result.get("data") or []
                if isinstance(data, list) and len(data) >= 90:
                    prices = [float(row.get("MCP") or row.get("Price") or 0) for row in data]
                    valid = [p for p in prices if p > 0]
                    if valid:
                        blocks = prices
                        if daily_avg is None:
                            daily_avg = round(mean(valid), 2)

            elif isinstance(result, list) and len(result) >= 90:
                prices = [float(r.get("MCP") or r.get("Price") or 0) for r in result]
                valid = [p for p in prices if p > 0]
                if valid:
                    blocks = prices
                    if daily_avg is None:
                        daily_avg = round(mean(valid), 2)

            if daily_avg is not None:
                break
        if daily_avg is not None:
            break

    # Try block price endpoints separately if no blocks yet
    if blocks is None:
        for date_str in date_variants:
            payload = {"date": date_str, "Date": date_str}
            for endpoint in IEX_RTM_BLOCK_ENDPOINTS:
                result = _try_endpoint(session, endpoint, payload)
                if result is None:
                    continue
                data = result if isinstance(result, list) else (
                    result.get("Data") or result.get("data") or [])
                if isinstance(data, list) and len(data) >= 90:
                    prices = [float(r.get("MCP") or r.get("Price") or 0) for r in data]
                    if [p for p in prices if p > 0]:
                        blocks = prices
                        break
            if blocks:
                break

    return daily_avg, blocks


# ── Playwright fallback (stealth mode) ───────────────────────────────────────

def _fetch_rtm_via_playwright(target_date: date) -> tuple[float | None, list[float] | None]:
    """
    Use Playwright with stealth headers to scrape IEX RTM page.
    Injects JavaScript to call the internal API from inside the browser context.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("[RTM] Playwright not installed.")
        return None, None

    date_str = _iex_date_param(target_date)
    url = f"{IEX_BASE}/market-data/real-time-market/market-snapshot"

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"]
        )
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
            extra_http_headers={
                "Accept-Language": "en-US,en;q=0.9",
            }
        )
        # Remove automation markers
        context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
        """)

        page = context.new_page()
        captured_data = {"daily": None, "blocks": None}

        def handle_response(response):
            ct = response.headers.get("content-type", "")
            if "json" in ct:
                try:
                    body = response.json()
                    # Look for block data
                    if "d" in body:
                        inner = body["d"]
                        if isinstance(inner, str):
                            try:
                                inner = json.loads(inner)
                            except Exception:
                                pass
                        body = inner
                    if isinstance(body, dict):
                        data = body.get("Data") or body.get("data") or []
                        if isinstance(data, list) and len(data) >= 90:
                            prices = [float(r.get("MCP") or r.get("Price") or 0) for r in data]
                            valid = [p for p in prices if p > 0]
                            if valid:
                                captured_data["blocks"] = prices
                                captured_data["daily"] = round(mean(valid), 2)
                        for key in ("WeightedAvgMCP", "WAMCP", "AvgMCP"):
                            if key in body and body[key]:
                                captured_data["daily"] = round(float(body[key]), 2)
                except Exception:
                    pass

        page.on("response", handle_response)
        page.goto(url, wait_until="domcontentloaded", timeout=90000)
        page.wait_for_timeout(8000)

        # Try to call internal API using fetch from within the page context
        for endpoint in IEX_RTM_ENDPOINTS + IEX_RTM_BLOCK_ENDPOINTS:
            if captured_data["daily"] is not None and captured_data["blocks"] is not None:
                break
            try:
                result = page.evaluate(f"""
                    async () => {{
                        try {{
                            const r = await fetch('{endpoint}', {{
                                method: 'POST',
                                headers: {{'Content-Type': 'application/json; charset=utf-8',
                                           'X-Requested-With': 'XMLHttpRequest'}},
                                body: JSON.stringify({{date: '{date_str}'}})
                            }});
                            return await r.json();
                        }} catch(e) {{ return null; }}
                    }}
                """)
                if result:
                    # Parse result
                    inner = result.get("d", result)
                    if isinstance(inner, str):
                        try:
                            inner = json.loads(inner)
                        except Exception:
                            pass
                    if isinstance(inner, dict):
                        data = inner.get("Data") or inner.get("data") or []
                        if isinstance(data, list) and len(data) >= 90:
                            prices = [float(r.get("MCP") or r.get("Price") or 0) for r in data]
                            valid = [p for p in prices if p > 0]
                            if valid:
                                captured_data["blocks"] = prices
                                captured_data["daily"] = round(mean(valid), 2)
            except Exception:
                pass

        # DOM fallback: look for MCP values in the page text
        if captured_data["daily"] is None:
            text = page.inner_text("body")
            for pat in [
                r"Weighted\s+Avg(?:erage)?\s+MCP[:\s]+(\d+\.?\d*)",
                r"WAMCP[:\s]+(\d+\.?\d*)",
                r"Avg(?:erage)?\s+(?:Price|MCP)[:\s]+(\d+\.?\d*)",
            ]:
                m = re.search(pat, text, re.IGNORECASE)
                if m:
                    captured_data["daily"] = round(float(m.group(1)), 2)
                    break

        browser.close()

    return captured_data["daily"], captured_data["blocks"]


# ── Main logic ────────────────────────────────────────────────────────────────

def scrape_rtm(target_date: date | None = None) -> bool:
    if target_date is None:
        target_date = date.today() - timedelta(days=1)

    csv_path = CSV_PATHS["rtm"]

    last = _last_date_in_csv(csv_path)
    if last and last >= target_date:
        print(f"[RTM] Data for {target_date} already present. Skipping.")
        return True

    print(f"[RTM] Fetching data for {target_date}...")

    daily_avg, blocks = _fetch_rtm_api(target_date)

    if daily_avg is None or blocks is None:
        print("[RTM] API incomplete; trying Playwright stealth mode...")
        pw_avg, pw_blocks = _fetch_rtm_via_playwright(target_date)
        if daily_avg is None:
            daily_avg = pw_avg
        if blocks is None:
            blocks = pw_blocks

    if daily_avg is None:
        print(f"[RTM] ERROR: Could not fetch daily avg for {target_date}.")
        return False

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
        csv.writer(f).writerow(row)

    print(f"[RTM] Done for {target_date}.")
    return True


if __name__ == "__main__":
    success = scrape_rtm()
    sys.exit(0 if success else 1)
