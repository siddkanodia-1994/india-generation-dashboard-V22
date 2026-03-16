"""
Scrape daily stock price and P/B ratio for each ticker from Screener.in
and append to stock.xlsx (sheets: "Prices" and "P/B").

Reads STOCK_TICKERS from config.py.
"""

import re
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).parent))
from config import CSV_PATHS, SCREENER_BASE_URL, STOCK_TICKERS

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

def _format_date(d: date) -> str:
    return d.strftime("%d/%m/%y")


def _last_date_in_sheet(ws) -> date | None:
    """Return last date in column A of an openpyxl worksheet, or None."""
    last = None
    for row in ws.iter_rows(min_row=2, max_col=1, values_only=True):
        val = row[0]
        if val is None:
            continue
        if isinstance(val, date):
            last = val
        elif isinstance(val, str):
            try:
                parts = val.strip().split("/")
                d, m, y = int(parts[0]), int(parts[1]), int(parts[2])
                if y < 100:
                    y += 2000
                last = date(y, m, d)
            except Exception:
                pass
    return last


def _get_column_index(ws, ticker: str) -> int | None:
    """Find the 1-based column index of ticker in row 1, or None."""
    for col in range(1, ws.max_column + 2):
        val = ws.cell(row=1, column=col).value
        if val is None:
            return None
        if str(val).strip().upper() == ticker.upper():
            return col
    return None


def _ensure_ticker_column(ws, ticker: str) -> int:
    """Return existing column for ticker, or add it and return new index."""
    idx = _get_column_index(ws, ticker)
    if idx is not None:
        return idx
    new_col = ws.max_column + 1
    ws.cell(row=1, column=new_col, value=ticker)
    return new_col


# ── Scraping ──────────────────────────────────────────────────────────────────

def _scrape_screener(ticker: str) -> dict | None:
    """
    Scrape current price and P/B ratio for a ticker from Screener.in.
    Returns {"price": float, "pb": float} or None.
    """
    url = SCREENER_BASE_URL.format(ticker=ticker)
    try:
        r = SESSION.get(url, timeout=20)
        if r.status_code == 404:
            # Try consolidated page
            r = SESSION.get(url.rstrip("/") + "/consolidated/", timeout=20)
        r.raise_for_status()
    except Exception as e:
        print(f"[STOCKS] Failed to fetch {ticker}: {e}")
        return None

    soup = BeautifulSoup(r.text, "lxml")

    price = None
    pb = None

    # ── Current price ─────────────────────────────────────────────────────
    # Screener shows price in <span class="number"> inside the stock header
    price_candidates = [
        soup.find("span", {"id": "company-current-price"}),
        soup.find("div", class_=re.compile(r"stock-price|current-price")),
    ]
    for el in price_candidates:
        if el:
            text = re.sub(r"[^\d.]", "", el.get_text())
            try:
                price = float(text)
                break
            except Exception:
                pass

    # Fallback: look for "Current Price" label in the top ratios section
    if price is None:
        for li in soup.find_all("li"):
            name = li.find("span", class_="name")
            number = li.find("span", class_="number")
            if name and number:
                if "current price" in name.get_text(strip=True).lower():
                    text = re.sub(r"[^\d.]", "", number.get_text())
                    try:
                        price = float(text)
                    except Exception:
                        pass

    # ── P/B Ratio ─────────────────────────────────────────────────────────
    for li in soup.find_all("li"):
        name_el = li.find("span", class_="name")
        num_el  = li.find("span", class_="number")
        if name_el and num_el:
            label = name_el.get_text(strip=True).lower()
            if "price to book" in label or "p/b" in label or "pb ratio" in label:
                text = re.sub(r"[^\d.]", "", num_el.get_text())
                try:
                    pb = float(text)
                except Exception:
                    pass
                break

    if price is None and pb is None:
        print(f"[STOCKS] WARNING: No data found for {ticker} at {url}")
        return None

    return {"price": price, "pb": pb}


# ── XLSX update ───────────────────────────────────────────────────────────────

def _update_xlsx(results: dict[str, dict | None], target_date: date) -> bool:
    """
    Append one row of prices and one row of P/B ratios to stock.xlsx.
    results: {ticker: {"price": float, "pb": float} or None}
    """
    import openpyxl

    xlsx_path = CSV_PATHS["stocks"]
    p = Path(xlsx_path)

    if p.exists():
        wb = openpyxl.load_workbook(xlsx_path)
    else:
        wb = openpyxl.Workbook()
        wb.active.title = "Prices"
        wb.create_sheet("P/B")

    prices_ws = wb["Prices"] if "Prices" in wb.sheetnames else wb.active
    pb_ws     = wb["P/B"]    if "P/B"    in wb.sheetnames else wb.create_sheet("P/B")

    # Ensure headers exist
    if prices_ws.max_row == 0 or prices_ws.cell(1, 1).value is None:
        prices_ws.cell(1, 1, "Date")
    if pb_ws.max_row == 0 or pb_ws.cell(1, 1).value is None:
        pb_ws.cell(1, 1, "Date")

    # Idempotency check
    last_price_date = _last_date_in_sheet(prices_ws)
    if last_price_date and last_price_date >= target_date:
        print(f"[STOCKS] Data for {target_date} already in Prices sheet. Skipping.")
        return True

    date_str = _format_date(target_date)

    # New rows
    price_new_row = prices_ws.max_row + 1
    pb_new_row    = pb_ws.max_row + 1

    prices_ws.cell(price_new_row, 1, date_str)
    pb_ws.cell(pb_new_row, 1, date_str)

    for ticker, data in results.items():
        if data is None:
            continue
        price_col = _ensure_ticker_column(prices_ws, ticker)
        pb_col    = _ensure_ticker_column(pb_ws, ticker)

        if data.get("price") is not None:
            prices_ws.cell(price_new_row, price_col, data["price"])
        if data.get("pb") is not None:
            pb_ws.cell(pb_new_row, pb_col, data["pb"])

    wb.save(xlsx_path)
    return True


# ── Main logic ────────────────────────────────────────────────────────────────

def scrape_stocks(target_date: date | None = None) -> bool:
    if target_date is None:
        target_date = date.today() - timedelta(days=1)

    print(f"[STOCKS] Scraping {len(STOCK_TICKERS)} tickers for {target_date}...")

    results: dict[str, dict | None] = {}
    for ticker in STOCK_TICKERS:
        print(f"[STOCKS] Fetching {ticker}...")
        data = _scrape_screener(ticker)
        results[ticker] = data
        if data:
            print(f"[STOCKS] {ticker}: price={data.get('price')}, P/B={data.get('pb')}")
        time.sleep(2)  # Be polite to Screener.in

    if all(v is None for v in results.values()):
        print("[STOCKS] ERROR: All tickers failed.")
        return False

    success = _update_xlsx(results, target_date)
    if success:
        print(f"[STOCKS] Done for {target_date}.")
    return success


if __name__ == "__main__":
    ok = scrape_stocks()
    sys.exit(0 if ok else 1)
