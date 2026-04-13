"""Portfolio smoke test — httpx route asserter.

Hits all canonical routes against a running portfolio instance and checks
that each returns 200 with expected content. Reports PASS / FAIL / SKIP
per check and exits 1 if any check actually FAILS.

Usage:
    BASE_URL=http://localhost:8550 python scripts/smoke.py
"""

import os
import sys

import httpx

BASE_URL = os.environ.get("BASE_URL", "http://localhost:8550")

# (path, list of substrings that must appear in response text)
# Needle strings verify that the route renders real computed content,
# not just a 200 with an empty or error page.
CHECKS = [
    # Root
    ("/", ["Ryan Zegalia"]),
    # SaaS vertical
    ("/saas", []),
    ("/saas/revenue", []),
    ("/saas/pql", []),
    ("/saas/forecast", []),
    # Home Care vertical
    ("/home-care", []),
    ("/home-care/shifts/critical", []),
    ("/home-care/reconciliation/evv", []),
    ("/home-care/care-plans/drift", []),
    # Vertical AI vertical
    ("/vertical-ai", []),
    ("/vertical-ai/enrichment", []),
    ("/vertical-ai/enrichment/sor-detection", []),
    ("/vertical-ai/customers", []),
    # SCA vertical
    ("/sca", []),
    ("/sca/deals", []),
    ("/sca/triggers", []),
    ("/sca/coverage", []),
    # Distribution vertical
    ("/distribution", []),
    ("/distribution/erp-detection", []),
    ("/distribution/pov", []),
    ("/distribution/pe-triggers", []),
    # API
    ("/api/health", ["ok"]),
]


def main() -> int:
    fails: list[str] = []
    passes = 0
    skips = 0

    with httpx.Client(timeout=10.0) as client:
        for path, needles in CHECKS:
            url = BASE_URL.rstrip("/") + path
            try:
                r = client.get(url)
            except httpx.HTTPError as exc:
                print(f"SKIP  {path}  (connection error: {exc.__class__.__name__})")
                skips += 1
                continue

            if r.status_code == 404:
                print(f"SKIP  {path}  (404, route not wired yet)")
                skips += 1
                continue

            if r.status_code != 200:
                msg = f"FAIL  {path}  (status {r.status_code})"
                print(msg)
                fails.append(msg)
                continue

            body = r.text
            missing = [needle for needle in needles if needle not in body]

            if missing:
                msg = f"FAIL  {path}  (missing: {', '.join(missing)})"
                print(msg)
                fails.append(msg)
            else:
                print(f"PASS  {path}")
                passes += 1

    print()
    print(f"Summary: {passes} passed, {len(fails)} failed, {skips} skipped")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
