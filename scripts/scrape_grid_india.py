"""
Scrape Grid India Daily PSP Report (PDF) and append to:
  - supply.csv        : Total energy met (MU)
  - Peak Demand.csv   : Peak demand met (GW)
  - generation.csv    : Total generation, Thermal (coal), Renewable (solar+wind)

The PSP PDF is published on grid-india.in for the *previous* day.
This script is designed to be run multiple times (idempotent) between 9am–11am IST
until the PDF becomes available. It exits with code 0 on success OR if data already
present; exits with code 2 if PDF not yet published (so workflow can retry).
"""

import csv
import io
import re
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).parent))
from config import CSV_PATHS, GRID_INDIA_REPORTS_URL, GRID_INDIA_PDF_BASE

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
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


# ── PDF discovery ─────────────────────────────────────────────────────────────

def _find_pdf_url(target_date: date) -> str | None:
    """
    Search the Grid India reports page for the PSP PDF link for target_date.
    Returns the full URL or None.
    """
    # Common filename patterns:
    #   PSP_15_03_2026.pdf  /  Daily_PSP_Report_15032026.pdf  /  PSP15032026.pdf
    date_variants = [
        target_date.strftime("%d_%m_%Y"),     # 15_03_2026
        target_date.strftime("%d%m%Y"),        # 15032026
        target_date.strftime("%d-%m-%Y"),      # 15-03-2026
        target_date.strftime("%d.%m.%Y"),      # 15.03.2026
    ]

    try:
        r = requests.get(GRID_INDIA_REPORTS_URL, headers=HEADERS, timeout=20)
        r.raise_for_status()
    except Exception as e:
        print(f"[GRID] Failed to load reports page: {e}")
        return None

    soup = BeautifulSoup(r.text, "lxml")
    links = soup.find_all("a", href=True)

    for link in links:
        href: str = link["href"]
        lower = href.lower()
        if "psp" in lower and href.endswith(".pdf"):
            for variant in date_variants:
                if variant in href or variant.replace("_", "") in href:
                    if href.startswith("http"):
                        return href
                    return GRID_INDIA_PDF_BASE + href

    # Fallback: try common URL patterns directly
    for pattern in [
        f"/NLDC/NLDC_Daily_Report/PSP_{target_date.strftime('%d_%m_%Y')}.pdf",
        f"/uploads/PSP_{target_date.strftime('%d_%m_%Y')}.pdf",
        f"/reports/PSP_{target_date.strftime('%d%m%Y')}.pdf",
    ]:
        url = GRID_INDIA_PDF_BASE + pattern
        try:
            resp = requests.head(url, headers=HEADERS, timeout=10, allow_redirects=True)
            if resp.status_code == 200:
                return url
        except Exception:
            continue

    return None


# ── PDF parsing ───────────────────────────────────────────────────────────────

def _parse_psp_pdf(pdf_bytes: bytes) -> dict | None:
    """
    Parse the PSP PDF and extract:
      - peak_demand_gw    : peak demand met (GW)
      - total_energy_mu   : total energy met / supply (MU)
      - total_generation  : total generation (MU)
      - thermal_generation: thermal/coal generation (MU)
      - renewable_generation: solar + wind generation (MU)

    Returns a dict or None if parsing fails.
    """
    try:
        import pdfplumber
    except ImportError:
        print("[GRID] pdfplumber not installed. Run: pip install pdfplumber")
        return None

    result = {}

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        full_text = "\n".join(page.extract_text() or "" for page in pdf.pages)

    # ── Peak Demand ────────────────────────────────────────────────────────
    # Pattern: "Peak Demand Met: 195.23 GW" or "Peak Demand  195.23"
    peak_patterns = [
        r"Peak\s+Demand\s+Met[:\s]+(\d+[\.,]\d+)\s*GW",
        r"Peak\s+Demand[:\s]+(\d+[\.,]\d+)\s*GW",
        r"Peak\s+Demand\s+Met\s*\(GW\)[:\s]+(\d+[\.,]\d+)",
        r"Max\s+Demand\s+Met[:\s]+(\d+[\.,]\d+)",
    ]
    for pat in peak_patterns:
        m = re.search(pat, full_text, re.IGNORECASE)
        if m:
            result["peak_demand_gw"] = round(float(m.group(1).replace(",", ".")), 2)
            break

    # ── Total Energy Met (Supply) ──────────────────────────────────────────
    # Pattern: "Energy Met: 5432.10 MU" or "Total Energy Met  5432 MU"
    supply_patterns = [
        r"(?:Total\s+)?Energy\s+Met[:\s]+(\d[\d,]+\.?\d*)\s*MU",
        r"Energy\s+Supplied[:\s]+(\d[\d,]+\.?\d*)\s*MU",
        r"Total\s+Demand\s+Met[:\s]+(\d[\d,]+\.?\d*)\s*MU",
    ]
    for pat in supply_patterns:
        m = re.search(pat, full_text, re.IGNORECASE)
        if m:
            result["total_energy_mu"] = round(float(m.group(1).replace(",", "")), 0)
            break

    # ── Generation breakdown ───────────────────────────────────────────────
    # Try to find a table with generation by source
    thermal_mu = None
    solar_mu = None
    wind_mu = None
    total_gen_mu = None

    # Pattern: "Thermal   XXXX" in table rows
    thermal_patterns = [
        r"(?:Thermal|Coal)[:\s]+(\d[\d,]+\.?\d*)\s*MU",
        r"Thermal\s+Generation[:\s]+(\d[\d,]+\.?\d*)",
        r"Thermal\s+(\d[\d,]+\.?\d*)\s+\d",  # table row
    ]
    for pat in thermal_patterns:
        m = re.search(pat, full_text, re.IGNORECASE)
        if m:
            thermal_mu = round(float(m.group(1).replace(",", "")), 0)
            break

    solar_patterns = [
        r"Solar[:\s]+(\d[\d,]+\.?\d*)\s*MU",
        r"Solar\s+(\d[\d,]+\.?\d*)\s+\d",
    ]
    for pat in solar_patterns:
        m = re.search(pat, full_text, re.IGNORECASE)
        if m:
            solar_mu = round(float(m.group(1).replace(",", "")), 0)
            break

    wind_patterns = [
        r"Wind[:\s]+(\d[\d,]+\.?\d*)\s*MU",
        r"Wind\s+(\d[\d,]+\.?\d*)\s+\d",
    ]
    for pat in wind_patterns:
        m = re.search(pat, full_text, re.IGNORECASE)
        if m:
            wind_mu = round(float(m.group(1).replace(",", "")), 0)
            break

    total_patterns = [
        r"Total\s+Generation[:\s]+(\d[\d,]+\.?\d*)\s*MU",
        r"Total\s+Gen[:\s]+(\d[\d,]+\.?\d*)",
    ]
    for pat in total_patterns:
        m = re.search(pat, full_text, re.IGNORECASE)
        if m:
            total_gen_mu = round(float(m.group(1).replace(",", "")), 0)
            break

    # Derive total generation from supply if not found directly
    if total_gen_mu is None and result.get("total_energy_mu"):
        total_gen_mu = result["total_energy_mu"]

    # Derive renewable from solar + wind
    renewable_mu = None
    if solar_mu is not None and wind_mu is not None:
        renewable_mu = solar_mu + wind_mu
    elif solar_mu is not None:
        renewable_mu = solar_mu
    elif wind_mu is not None:
        renewable_mu = wind_mu

    # If thermal not found but total and renewable are, derive thermal
    if thermal_mu is None and total_gen_mu and renewable_mu:
        thermal_mu = total_gen_mu - renewable_mu

    if total_gen_mu:
        result["total_generation"] = total_gen_mu
    if thermal_mu:
        result["thermal_generation"] = thermal_mu
    if renewable_mu:
        result["renewable_generation"] = renewable_mu

    if not result:
        print("[GRID] WARNING: Could not extract any values from PDF.")
        print("[GRID] Full text preview:\n", full_text[:2000])
        return None

    return result


# ── CSV writers ───────────────────────────────────────────────────────────────

def _append_csv(path: str, row: list) -> None:
    with open(path, "a", newline="") as f:
        csv.writer(f).writerow(row)


# ── Main logic ────────────────────────────────────────────────────────────────

def scrape_grid_india(target_date: date | None = None) -> bool:
    """
    Returns True on success, False on hard failure.
    Raises SystemExit(2) if PDF not yet published (retry signal).
    """
    if target_date is None:
        # PSP report covers the previous calendar day
        target_date = date.today() - timedelta(days=1)

    # Idempotency: check supply.csv (representative)
    last = _last_date_in_csv(CSV_PATHS["supply"])
    if last and last >= target_date:
        print(f"[GRID] Data for {target_date} already present. Skipping.")
        return True

    print(f"[GRID] Looking for PSP PDF for {target_date}...")

    pdf_url = _find_pdf_url(target_date)
    if pdf_url is None:
        print(f"[GRID] PDF not yet available for {target_date}. Will retry.")
        sys.exit(2)  # Signals "not ready yet" to GitHub Actions

    print(f"[GRID] Found PDF: {pdf_url}")

    try:
        r = requests.get(pdf_url, headers=HEADERS, timeout=60)
        r.raise_for_status()
        pdf_bytes = r.content
    except Exception as e:
        print(f"[GRID] Failed to download PDF: {e}")
        return False

    data = _parse_psp_pdf(pdf_bytes)
    if data is None:
        print("[GRID] ERROR: PDF parsing returned no data.")
        return False

    date_str = _format_date(target_date)

    # Write supply.csv
    if "total_energy_mu" in data:
        _append_csv(CSV_PATHS["supply"], [date_str, data["total_energy_mu"]])
        print(f"[GRID] Supply: {data['total_energy_mu']} MU")
    else:
        print("[GRID] WARNING: total_energy_mu not found.")

    # Write Peak Demand.csv
    if "peak_demand_gw" in data:
        _append_csv(CSV_PATHS["demand"], [date_str, data["peak_demand_gw"]])
        print(f"[GRID] Peak Demand: {data['peak_demand_gw']} GW")
    else:
        print("[GRID] WARNING: peak_demand_gw not found.")

    # Write generation.csv (Date, Total, Thermal/Coal, Renewable)
    if "total_generation" in data:
        thermal  = data.get("thermal_generation", "")
        renewabl = data.get("renewable_generation", "")
        _append_csv(CSV_PATHS["generation"], [date_str, data["total_generation"], thermal, renewabl])
        print(f"[GRID] Generation: total={data['total_generation']}, thermal={thermal}, renewable={renewabl}")
    else:
        print("[GRID] WARNING: total_generation not found.")

    print(f"[GRID] Done for {target_date}.")
    return True


if __name__ == "__main__":
    success = scrape_grid_india()
    sys.exit(0 if success else 1)
