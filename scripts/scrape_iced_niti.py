"""
Scrape ICED NITI (https://iced.niti.gov.in/) for:
  --mode coal_plf  : Daily Coal PLF (%) → Coal PLF.csv
  --mode capacity  : Monthly installed capacity by source → capacity.csv

Usage:
  python scrape_iced_niti.py --mode coal_plf
  python scrape_iced_niti.py --mode capacity
"""

import argparse
import csv
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

def _scrape_coal_plf(target_date: date) -> float | None:
    """
    Scrape daily coal PLF % from ICED NITI.
    Returns PLF value or None.
    """
    # Try known API endpoints / data endpoints on ICED NITI
    api_candidates = [
        f"{ICED_NITI_URL}api/coal-plf",
        f"{ICED_NITI_URL}api/power/coalplf",
        f"{ICED_NITI_URL}api/daily-stats",
        f"{ICED_NITI_URL}data/coal-plf.json",
    ]
    date_str_variants = [
        target_date.strftime("%Y-%m-%d"),
        target_date.strftime("%d-%m-%Y"),
        target_date.strftime("%d/%m/%Y"),
    ]
    for api_url in api_candidates:
        for ds in date_str_variants:
            try:
                r = SESSION.get(api_url, params={"date": ds}, timeout=15)
                if r.status_code == 200:
                    data = r.json()
                    # Look for PLF value in response
                    for key in ("plf", "PLF", "coal_plf", "CoalPLF", "value", "Value"):
                        if key in data:
                            return round(float(data[key]), 2)
                    if isinstance(data, list) and data:
                        first = data[0]
                        for key in ("plf", "PLF", "coal_plf", "value"):
                            if key in first:
                                return round(float(first[key]), 2)
            except Exception:
                continue

    # Fallback: scrape the dashboard page
    soup = _get_soup(ICED_NITI_URL)
    if soup is None:
        return None

    # Look for "Coal PLF" text near a percentage value
    text = soup.get_text(" ", strip=True)
    plf_patterns = [
        r"Coal\s+PLF[:\s]+(\d+\.?\d*)\s*%",
        r"PLF\s*\(Coal\)[:\s]+(\d+\.?\d*)",
        r"(\d{2}\.\d{1,2})\s*%.*?Coal\s+PLF",
    ]
    for pat in plf_patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            return round(float(m.group(1)), 2)

    return None


def scrape_coal_plf(target_date: date | None = None) -> bool:
    if target_date is None:
        target_date = date.today() - timedelta(days=1)

    csv_path = CSV_PATHS["coal_plf"]
    last = _last_date_in_csv(csv_path)
    if last and last >= target_date:
        print(f"[NITI-PLF] Data for {target_date} already present. Skipping.")
        return True

    print(f"[NITI-PLF] Fetching Coal PLF for {target_date}...")
    plf = _scrape_coal_plf(target_date)

    if plf is None:
        print(f"[NITI-PLF] ERROR: Could not fetch Coal PLF for {target_date}.")
        return False

    row = [_format_date_dd_mm_yy(target_date), plf]
    print(f"[NITI-PLF] Writing: {row}")
    with open(csv_path, "a", newline="") as f:
        csv.writer(f).writerow(row)

    print(f"[NITI-PLF] Done for {target_date}.")
    return True


# ── Capacity ──────────────────────────────────────────────────────────────────

CAPACITY_SOURCES = ["Coal", "Oil & Gas", "Nuclear", "Hydro", "Solar", "Wind", "Small-Hydro", "Bio Power"]


def _scrape_capacity(target_month_date: date) -> dict | None:
    """
    Scrape monthly installed capacity (GW) by source from ICED NITI.
    target_month_date is the 1st of the target month.
    Returns dict of {source: gw_value} or None.
    """
    api_candidates = [
        f"{ICED_NITI_URL}api/capacity",
        f"{ICED_NITI_URL}api/power/capacity",
        f"{ICED_NITI_URL}api/installed-capacity",
        f"{ICED_NITI_URL}data/capacity.json",
    ]
    month_str = target_month_date.strftime("%m/%Y")
    for api_url in api_candidates:
        try:
            r = SESSION.get(api_url, params={"month": month_str}, timeout=15)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, dict):
                    cap = {}
                    key_map = {
                        "coal":       "Coal",
                        "oil":        "Oil & Gas",
                        "gas":        "Oil & Gas",
                        "nuclear":    "Nuclear",
                        "hydro":      "Hydro",
                        "solar":      "Solar",
                        "wind":       "Wind",
                        "smallhydro": "Small-Hydro",
                        "bio":        "Bio Power",
                    }
                    for k, v in data.items():
                        for fragment, mapped in key_map.items():
                            if fragment in k.lower():
                                cap[mapped] = round(float(v), 0)
                    if cap:
                        return cap
        except Exception:
            continue

    # Fallback: scrape page
    soup = _get_soup(ICED_NITI_URL)
    if soup is None:
        return None

    # Attempt to find a data table
    tables = soup.find_all("table")
    for table in tables:
        text = table.get_text(" ", strip=True).lower()
        if "coal" in text and ("solar" in text or "wind" in text):
            cap = {}
            rows = table.find_all("tr")
            for row in rows:
                cells = [td.get_text(strip=True) for td in row.find_all(["td", "th"])]
                if len(cells) >= 2:
                    label = cells[0].lower()
                    for source in CAPACITY_SOURCES:
                        if source.lower() in label:
                            try:
                                cap[source] = round(float(re.sub(r"[^\d.]", "", cells[1])), 0)
                            except Exception:
                                pass
            if cap:
                return cap

    return None


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
    date_str = target_month.strftime("01/%m/%Y")
    row = [
        date_str,
        cap.get("Coal", ""),
        cap.get("Oil & Gas", ""),
        cap.get("Nuclear", ""),
        cap.get("Hydro", ""),
        cap.get("Solar", ""),
        cap.get("Wind", ""),
        cap.get("Small-Hydro", ""),
        cap.get("Bio Power", ""),
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
    args = parser.parse_args()

    if args.mode == "coal_plf":
        success = scrape_coal_plf()
    else:
        success = scrape_capacity()

    sys.exit(0 if success else 1)
