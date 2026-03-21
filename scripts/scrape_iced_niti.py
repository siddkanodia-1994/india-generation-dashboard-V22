"""
Scrape ICED NITI (https://iced.niti.gov.in/) for:
  --mode coal_plf  : Daily Coal PLF (%) → Coal PLF.csv
  --mode capacity  : Monthly installed capacity by source → capacity.csv

Usage:
  python scrape_iced_niti.py --mode coal_plf
  python scrape_iced_niti.py --mode capacity
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).parent))
from config import CSV_PATHS, ICED_NITI_URL

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
}

SESSION = requests.Session()
SESSION.headers.update(HEADERS)

# ── ICED NITI REST API (coal PLF) ─────────────────────────────────────────────
_ICED_API_URL = "https://icedapi.niti.gov.in/v1/performanceFilter"
_ICED_API_KEY = "AHten@VP0W3R"
_ICED_HEADERS = {
    "KEY": _ICED_API_KEY,
    "Origin": "https://iced.niti.gov.in",
    "Content-Type": "application/json",
}
_PLF_PARAM_OBJ = [{
    "name": "Plant Load Factor / CUF", "id": "plantLoadFactor",
    "filterType": "parameter", "valueSuffix": "%", "graphType": "line",
    "selected": True, "sources": True, "sourceLimit": 4,
    "filterBy": True, "compareBy": True, "rangeBy": True, "dualAxis": True, "chartAxis": "first",
}]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _last_date_in_csv(path: str) -> date | None:
    p = Path(path)
    if not p.exists():
        return None
    with open(p, newline="") as f:
        rows = list(csv.reader(f))
    data_rows = [r for r in rows if r and not r[0].startswith(("Date", "Capacity"))]
    if not data_rows:
        return None
    last = data_rows[-1][0].strip()
    try:
        parts = last.split("/")
        if len(parts) == 3:
            d, m, y = parts
            y = int(y)
            if y < 100:
                y += 2000
            return date(y, int(m), int(d))
    except Exception:
        pass
    return None


def _format_date_dd_mm_yy(d: date) -> str:
    return d.strftime("%d/%m/%y")


def _format_date_dd_mm_yyyy(d: date) -> str:
    return d.strftime("%d/%m/%Y")


def _fetch_page(url: str) -> BeautifulSoup | None:
    try:
        r = SESSION.get(url, timeout=30)
        r.raise_for_status()
        return BeautifulSoup(r.text, "lxml")
    except Exception as e:
        print(f"[NITI] Failed to fetch {url}: {e}")
        return None


def _fetch_via_playwright(url: str) -> BeautifulSoup | None:
    """Fallback: render JS page with Playwright."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("[NITI] Playwright not installed.")
        return None
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(url, wait_until="networkidle", timeout=60000)
        html = page.content()
        browser.close()
    return BeautifulSoup(html, "lxml")


def _get_soup(url: str) -> BeautifulSoup | None:
    soup = _fetch_page(url)
    if soup is None:
        print("[NITI] Static fetch failed; trying Playwright...")
        soup = _fetch_via_playwright(url)
    return soup


# ── Coal PLF ─────────────────────────────────────────────────────────────────

def _decrypt_iced(encrypted_json_str: str):
    """Decrypt CryptoJS AES.encrypt() response (OpenSSL AES-256-CBC format)."""
    import base64
    import hashlib
    from Crypto.Cipher import AES

    b64 = json.loads(encrypted_json_str)
    raw = base64.b64decode(b64)
    salt = raw[8:16]
    encrypted = raw[16:]
    passphrase = _ICED_API_KEY.encode()
    d = b""
    di = b""
    while len(d) < 48:
        di = hashlib.md5(di + passphrase + salt).digest()
        d += di
    key, iv = d[:32], d[32:48]
    cipher = AES.new(key, AES.MODE_CBC, iv)
    decrypted = cipher.decrypt(encrypted)
    decrypted = decrypted[: -decrypted[-1]]  # Remove PKCS7 padding
    return json.loads(decrypted.decode("utf-8"))


def _fetch_coal_plf_range(start: date, end: date) -> list:
    """Fetch daily coal PLF for a date window. Returns sorted [(date, plf), ...]."""
    body = {
        "parameter": ["plantLoadFactor"],
        "paramObj": _PLF_PARAM_OBJ,
        "dualObj": [],
        "dual": False,
        "source": ["coal"],
        "compare": [],
        "filter": [],
        "analyticsType": "",
        "startDate": start.strftime("%Y-%m-%d"),
        "endDate": end.strftime("%Y-%m-%d"),
        "rangeType": "day",
    }
    resp = SESSION.post(_ICED_API_URL, json=body, headers=_ICED_HEADERS, timeout=30)
    resp.raise_for_status()
    data = _decrypt_iced(resp.text)
    rows = []
    for item in data[0].get("data", []):
        d = date.fromisoformat(item["_id"]["year"])
        v = item.get("total")
        if v is not None:
            rows.append((d, round(float(v), 2)))
    return sorted(rows)


def scrape_coal_plf(target_date: date | None = None) -> bool:
    if target_date is None:
        target_date = date.today()

    csv_path = CSV_PATHS["coal_plf"]
    last = _last_date_in_csv(csv_path)

    # Fetch last 30 days — covers the ~7-day data lag on ICED NITI
    end = target_date
    start = end - timedelta(days=29)
    print(f"[NITI-PLF] Fetching coal PLF {start} → {end}...")
    try:
        rows = _fetch_coal_plf_range(start, end)
    except Exception as e:
        print(f"[NITI-PLF] API error: {e}")
        return False

    # Use set of existing dates to safely skip duplicates (handles trailing empty rows)
    existing = set()
    p = Path(csv_path)
    if p.exists():
        with open(p, newline="") as f:
            for row in csv.reader(f):
                fields = [x.strip() for x in row if x.strip()]
                if len(fields) < 2:
                    continue
                try:
                    parts = fields[0].split("/")
                    if len(parts) == 3:
                        dy, dm, yr = parts
                        yr = int(yr)
                        if yr < 100:
                            yr += 2000
                        existing.add(date(yr, int(dm), int(dy)))
                except Exception:
                    pass

    new_rows = [(d, v) for d, v in rows if d not in existing]
    if not new_rows:
        print(f"[NITI-PLF] Already up to date (last={last}).")
        return True

    with open(csv_path, "a", newline="") as f:
        w = csv.writer(f)
        for d, v in new_rows:
            row = [_format_date_dd_mm_yy(d), v]
            print(f"[NITI-PLF] Writing: {row}")
            w.writerow(row)

    print(f"[NITI-PLF] Done. Wrote {len(new_rows)} rows.")
    return True


# ── Capacity ──────────────────────────────────────────────────────────────────

CAPACITY_SOURCES = ["Coal", "Oil & Gas", "Nuclear", "Hydro", "Solar", "Wind", "Small-Hydro", "Bio Power"]


_CAPACITY_PARAM_OBJ = [{
    "name": "Capacity", "id": "capacity",
    "filterType": "parameter", "valueSuffix": "MW", "graphType": "bar",
    "selected": True, "sources": True, "sourceLimit": 10,
    "filterBy": True, "compareBy": True, "rangeBy": True, "dualAxis": True, "chartAxis": "first",
}]

_CAPACITY_SOURCE_MAP = {
    "coal":       "Coal",
    "oil-gas":    "Oil & Gas",
    "nuclear":    "Nuclear",
    "hydro":      "Hydro",
    "solar":      "Solar",
    "wind":       "Wind",
    "small-hydro": "Small-Hydro",
    "bio-power":  "Bio Power",
}


def _scrape_capacity(target_month_date: date) -> dict | None:
    """
    Fetch monthly installed capacity (GW) by source from ICED NITI performanceFilter API.
    target_month_date is the 1st of the target month.
    Returns dict of {source: gw_value} or None.
    """
    # Fetch a 6-month window ending at the target month
    start = (target_month_date.replace(day=1) - timedelta(days=150)).replace(day=1)
    end = target_month_date.replace(day=1)
    body = {
        "parameter": ["capacity"],
        "paramObj": _CAPACITY_PARAM_OBJ,
        "dualObj": [],
        "dual": False,
        "source": [],
        "compare": [],
        "filter": [],
        "analyticsType": "",
        "startDate": start.strftime("%Y-%m-%d"),
        "endDate": end.strftime("%Y-%m-%d"),
        "rangeType": "month",
    }
    try:
        resp = SESSION.post(_ICED_API_URL, json=body, headers=_ICED_HEADERS, timeout=30)
        resp.raise_for_status()
        data = _decrypt_iced(resp.text)
    except Exception as e:
        print(f"[NITI-CAP] API error: {e}")
        return None

    rows = data[0].get("data", []) if data else []
    target_key = target_month_date.strftime("%Y-%m")
    cap = {}
    for r in rows:
        if r["_id"].get("year") == target_key:
            src = r["_id"].get("source", "")
            mapped = _CAPACITY_SOURCE_MAP.get(src)
            if mapped:
                cap[mapped] = round(r["total"] / 1000, 0)  # MW → GW

    if not cap:
        print(f"[NITI-CAP] No data found for {target_key} in API response (months available: "
              f"{sorted(set(r['_id'].get('year','') for r in rows))})")
        return None

    return cap


def scrape_capacity(target_month: date | None = None) -> bool:
    """Append one row to capacity.csv for the given month."""
    if target_month is None:
        today = date.today()
        # Use first day of current month
        target_month = today.replace(day=1)

    csv_path = CSV_PATHS["capacity"]
    last = _last_date_in_csv(csv_path)
    # capacity.csv uses 01/MM/YYYY format
    if last and last >= target_month:
        print(f"[NITI-CAP] Data for {target_month.strftime('%m/%Y')} already present. Skipping.")
        return True

    print(f"[NITI-CAP] Fetching capacity for {target_month.strftime('%B %Y')}...")
    cap = _scrape_capacity(target_month)

    if cap is None:
        print(f"[NITI-CAP] ERROR: Could not fetch capacity data.")
        return False

    # Build row matching capacity.csv column order:
    # Capacity (GW), Coal, Oil & Gas, Nuclear, Hydro, Solar, Wind, Small-Hydro, Bio Power
    def _gw(src):
        v = cap.get(src)
        return int(v) if v is not None else ""

    date_str = target_month.strftime("01/%m/%Y")
    row = [
        date_str,
        _gw("Coal"),
        _gw("Oil & Gas"),
        _gw("Nuclear"),
        _gw("Hydro"),
        _gw("Solar"),
        _gw("Wind"),
        _gw("Small-Hydro"),
        _gw("Bio Power"),
    ]
    print(f"[NITI-CAP] Writing: {row}")
    with open(csv_path, "a", newline="") as f:
        csv.writer(f).writerow(row)

    print(f"[NITI-CAP] Done for {target_month.strftime('%B %Y')}.")
    return True


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scrape ICED NITI data")
    parser.add_argument("--mode", choices=["coal_plf", "capacity"], required=True)
    parser.add_argument("--backfill", action="store_true",
                        help="Backfill capacity: fill all missing months up to current month")
    args = parser.parse_args()

    if args.mode == "coal_plf":
        success = scrape_coal_plf()
    elif args.backfill:
        # Backfill: iterate from first missing month up to current month
        csv_path = CSV_PATHS["capacity"]
        last = _last_date_in_csv(csv_path)
        today = date.today()
        current_month = today.replace(day=1)
        start_month = (last.replace(day=1) + timedelta(days=32)).replace(day=1) if last else current_month
        success = True
        m = start_month
        while m <= current_month:
            ok = scrape_capacity(m)
            if not ok:
                print(f"[NITI-CAP] Backfill: no data yet for {m.strftime('%B %Y')} — stopping.")
                break
            m = (m + timedelta(days=32)).replace(day=1)
    else:
        success = scrape_capacity()

    sys.exit(0 if success else 1)
