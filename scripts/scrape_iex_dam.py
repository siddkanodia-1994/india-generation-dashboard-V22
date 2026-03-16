"""
Scrape IEX Day-Ahead Market (DAM) data and append to DAM Prices.csv.

Column written: Date, DAM price (daily weighted avg MCP in Rs/Unit)

Strategy:
  1. Try IEX internal API endpoints directly.
  2. Fall back to Playwright stealth mode.
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
from config import CSV_PATHS

IEX_BASE = "https://www.iexindia.com"

IEX_DAM_ENDPOINTS = [
    f"{IEX_BASE}/Modules/MarketData/DAM/frmDAMMarketSnapshot.aspx/GetDAMMarketSummary",
    f"{IEX_BASE}/api/MarketData/DAM/GetDAMMarketSummary",
    f"{IEX_BASE}/api/dam/summary",
    f"{IEX_BASE}/MarketData/DAM/GetMarketSummary",
]

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": f"{IEX_BASE}/market-data/day-ahead-market/market-snapshot",
    "Origin": IEX_BASE,
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
    return d.strftime("%d-%b-%Y")


def _make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(BROWSER_HEADERS)
    try:
        s.get(IEX_BASE, timeout=15)
        time.sleep(1)
    except Exception:
        pass
    return s


def _try_endpoint(session: requests.Session, url: str, payload: dict) -> dict | None:
    try:
        r = session.post(url, json=payload, timeout=20)
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
    try:
        r = session.get(url, params=payload, timeout=20)
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


# ── API approach ──────────────────────────────────────────────────────────────

def _fetch_dam_api(target_date: date) -> float | None:
    session = _make_session()
    date_variants = [
        _iex_date_param(target_date),
        target_date.strftime("%d/%m/%Y"),
        target_date.strftime("%Y-%m-%d"),
    ]
    for date_str in date_variants:
        payload = {"date": date_str, "Date": date_str}
        for endpoint in IEX_DAM_ENDPOINTS:
            result = _try_endpoint(session, endpoint, payload)
            if result is None:
                continue
            print(f"[DAM] Got response from {endpoint}")
            if isinstance(result, dict):
                for key in ("WeightedAvgMCP", "WAMCP", "AvgMCP", "MCP", "AvgPrice"):
                    if key in result and result[key]:
                        try:
                            return round(float(result[key]), 2)
                        except Exception:
                            pass
                data = result.get("Data") or result.get("data") or []
                if isinstance(data, list) and len(data) >= 20:
                    prices = [float(r.get("MCP") or r.get("Price") or 0) for r in data]
                    valid = [p for p in prices if p > 0]
                    if valid:
                        return round(mean(valid), 2)
            elif isinstance(result, list) and len(result) >= 20:
                prices = [float(r.get("MCP") or r.get("Price") or 0) for r in result]
                valid = [p for p in prices if p > 0]
                if valid:
                    return round(mean(valid), 2)
    return None


# ── Playwright fallback ───────────────────────────────────────────────────────

def _fetch_dam_via_playwright(target_date: date) -> float | None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("[DAM] Playwright not installed.")
        return None

    date_str = _iex_date_param(target_date)
    url = f"{IEX_BASE}/market-data/day-ahead-market/market-snapshot"
    captured = {"price": None}

    def handle_response(response):
        ct = response.headers.get("content-type", "")
        if "json" in ct and captured["price"] is None:
            try:
                body = response.json()
                if "d" in body:
                    inner = body["d"]
                    if isinstance(inner, str):
                        inner = json.loads(inner)
                    body = inner
                if isinstance(body, dict):
                    data = body.get("Data") or body.get("data") or []
                    if isinstance(data, list) and len(data) >= 20:
                        prices = [float(r.get("MCP") or r.get("Price") or 0) for r in data]
                        valid = [p for p in prices if p > 0]
                        if valid:
                            captured["price"] = round(mean(valid), 2)
                    for key in ("WeightedAvgMCP", "WAMCP", "AvgMCP"):
                        if key in body and body[key]:
                            captured["price"] = round(float(body[key]), 2)
            except Exception:
                pass

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"]
        )
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            )
        )
        context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined});")
        page = context.new_page()
        page.on("response", handle_response)
        page.goto(url, wait_until="domcontentloaded", timeout=90000)
        page.wait_for_timeout(8000)

        # Try internal API fetch from within the page
        if captured["price"] is None:
            for endpoint in IEX_DAM_ENDPOINTS:
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
                        inner = result.get("d", result)
                        if isinstance(inner, str):
                            inner = json.loads(inner)
                        if isinstance(inner, dict):
                            data = inner.get("Data") or inner.get("data") or []
                            if isinstance(data, list) and len(data) >= 20:
                                prices = [float(r.get("MCP") or r.get("Price") or 0) for r in data]
                                valid = [p for p in prices if p > 0]
                                if valid:
                                    captured["price"] = round(mean(valid), 2)
                                    break
                except Exception:
                    pass

        # DOM text fallback
        if captured["price"] is None:
            text = page.inner_text("body")
            for pat in [
                r"Weighted\s+Avg(?:erage)?\s+MCP[:\s]+(\d+\.?\d*)",
                r"WAMCP[:\s]+(\d+\.?\d*)",
                r"Avg(?:erage)?\s+(?:DAM\s+)?(?:Price|MCP)[:\s]+(\d+\.?\d*)",
            ]:
                m = re.search(pat, text, re.IGNORECASE)
                if m:
                    captured["price"] = round(float(m.group(1)), 2)
                    break

        browser.close()

    return captured["price"]


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
        print("[DAM] API failed; trying Playwright stealth mode...")
        dam_price = _fetch_dam_via_playwright(target_date)

    if dam_price is None:
        print(f"[DAM] ERROR: Could not fetch DAM price for {target_date}.")
        return False

    row = [_format_date(target_date), dam_price, "", ""]
    print(f"[DAM] Writing: {row}")

    with open(csv_path, "a", newline="") as f:
        csv.writer(f).writerow(row)

    print(f"[DAM] Done for {target_date}.")
    return True


if __name__ == "__main__":
    success = scrape_dam()
    sys.exit(0 if success else 1)
