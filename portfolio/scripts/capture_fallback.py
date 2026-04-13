"""Build-time Playwright PNG capture for static fallback screenshots.

Captures screenshots of the main routes against a running portfolio
instance and writes them to static/fallback/. These can be used for
social media previews or as visual regression baselines.

Note: The fallback PNG error handler was removed — this script is now
optional tooling for generating preview images, not a runtime dependency.

Usage:
    cd portfolio/
    python -m uvicorn app:app --host 127.0.0.1 --port 8550 &
    sleep 5
    python scripts/capture_fallback.py
"""
import os
import sys
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("Playwright not installed. Install with: pip install playwright && playwright install chromium")
    sys.exit(1)

BASE_URL = os.getenv("BASE_URL", "http://127.0.0.1:8550")
PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = PROJECT_ROOT / "static" / "fallback"

ROUTES = [
    # Root
    ("/", "root"),
    # SaaS
    ("/saas", "saas_operations"),
    ("/saas/revenue", "saas_revenue"),
    ("/saas/pql", "saas_pql"),
    ("/saas/forecast", "saas_forecast"),
    # Home Care
    ("/home-care", "home_care_operations"),
    ("/home-care/shifts/critical", "home_care_shifts"),
    ("/home-care/reconciliation/evv", "home_care_evv"),
    ("/home-care/care-plans/drift", "home_care_care_plans"),
    # Vertical AI
    ("/vertical-ai", "vertical_ai_operations"),
    ("/vertical-ai/enrichment", "vertical_ai_enrichment"),
    ("/vertical-ai/enrichment/sor-detection", "vertical_ai_sor_detection"),
    ("/vertical-ai/customers", "vertical_ai_customers"),
    # SCA
    ("/sca", "sca_operations"),
    ("/sca/deals", "sca_deals"),
    ("/sca/triggers", "sca_triggers"),
    ("/sca/coverage", "sca_coverage"),
    # Distribution
    ("/distribution", "distribution_operations"),
    ("/distribution/erp-detection", "distribution_erp"),
    ("/distribution/pov", "distribution_pov"),
    ("/distribution/pe-triggers", "distribution_pe"),
]


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        for route, name in ROUTES:
            url = BASE_URL + route
            print(f"capturing {url} -> {name}.png")
            try:
                page.goto(url, timeout=10000, wait_until="networkidle")
                page.screenshot(path=str(OUT_DIR / f"{name}.png"), full_page=True)
            except Exception as e:
                print(f"  failed: {e}")
        browser.close()
    print(f"\nWrote {len(ROUTES)} fallback screenshots to {OUT_DIR}")


if __name__ == "__main__":
    main()
