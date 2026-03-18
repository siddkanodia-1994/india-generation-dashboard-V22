"""
Central configuration for all scrapers.
Edit STOCK_TICKERS to match the companies in your stock.xlsx file.
"""

import os

# ── Stock tickers ────────────────────────────────────────────────────────────
# Add/remove tickers to match the column headers in stock.xlsx "Prices" sheet.
# Use the exact Screener.in URL slug (e.g. "NTPC" → screener.in/company/NTPC/)
STOCK_TICKERS = [
    "ACMESOLAR",
    "ADANIGREEN",
    "ADANIPOWER",
    "CESC",
    "INOXWIND",
    "JSWENERGY",
    "NTPC",
    "PFC",
    "RECLTD",
    "SUZLON",
    "TATAPOWER",
]

# Maps ticker symbol → exact column header used in stock.xlsx "Stock Prices" / "Stock P-B"
TICKER_COLUMN_NAMES = {
    "ACMESOLAR":  "Acme Solar Holdings Ltd",
    "ADANIGREEN": "Adani Green Energy Ltd",
    "ADANIPOWER": "Adani Power Ltd",
    "CESC":       "CESC Ltd",
    "INOXWIND":   "Inox Wind Ltd.",
    "JSWENERGY":  "JSW Energy Ltd",
    "NTPC":       "NTPC Ltd",
    "PFC":        "Power Finance Corporation Ltd.",
    "RECLTD":     "REC Ltd",
    "SUZLON":     "Suzlon Energy Ltd.",
    "TATAPOWER":  "Tata Power Company Ltd",
}

# ── CSV / XLSX paths (relative to repo root) ─────────────────────────────────
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CSV_PATHS = {
    "rtm":       os.path.join(BASE_DIR, "public", "data", "RTM Prices.csv"),
    "dam":       os.path.join(BASE_DIR, "public", "data", "DAM Prices.csv"),
    "supply":    os.path.join(BASE_DIR, "public", "data", "supply.csv"),
    "demand":    os.path.join(BASE_DIR, "public", "data", "Peak Demand.csv"),
    "demand_solar_nonsolar": os.path.join(BASE_DIR, "public", "data", "Peak Demand Solar-NonSolar.csv"),
    "generation":os.path.join(BASE_DIR, "public", "data", "generation.csv"),
    "coal_plf":  os.path.join(BASE_DIR, "public", "data", "Coal PLF.csv"),
    "capacity":  os.path.join(BASE_DIR, "public", "data", "capacity.csv"),
    "stocks":    os.path.join(BASE_DIR, "public", "data", "stock.xlsx"),
}

# ── IEX API base URLs ─────────────────────────────────────────────────────────
IEX_RTM_SUMMARY_URL  = "https://www.iexindia.com/Modules/MarketData/RTM/GetRTMMarketSummary.aspx"
IEX_RTM_HOURLY_URL   = "https://www.iexindia.com/Modules/MarketData/RTM/GetRTMHourlyData.aspx"
IEX_DAM_SUMMARY_URL  = "https://www.iexindia.com/Modules/MarketData/DAM/GetDAMMarketSummary.aspx"

# ── Grid India ────────────────────────────────────────────────────────────────
GRID_INDIA_REPORTS_URL = "https://grid-india.in/en/reports/daily-psp-report"
GRID_INDIA_PDF_BASE    = "https://grid-india.in"

# ── ICED NITI ────────────────────────────────────────────────────────────────
ICED_NITI_URL = "https://iced.niti.gov.in/"

# ── Screener.in ──────────────────────────────────────────────────────────────
SCREENER_BASE_URL = "https://www.screener.in/company/{ticker}/"

# ── RTM solar/non-solar time blocks (15-min intervals, 1-indexed, IST) ────────
# Block 1  = 00:00–00:15 IST
# Block 25 = 06:00–06:15 IST  ← solar hours start
# Block 72 = 17:45–18:00 IST  ← solar hours end
# Block 73 = 18:00–18:15 IST  ← non-solar hours start
# Block 96 = 23:45–00:00 IST  ← non-solar hours end
RTM_SOLAR_BLOCKS     = list(range(25, 73))   # blocks 25–72 inclusive
RTM_NONSOLAR_BLOCKS  = list(range(1, 25)) + list(range(73, 97))  # 1–24 + 73–96
