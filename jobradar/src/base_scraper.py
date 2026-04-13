"""Base scraper interface and shared utilities."""

import hashlib
import html as html_module
import logging
import re
from datetime import datetime, timezone

from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)


class BaseScraper:
    """Base class for all job board scrapers."""

    source_name: str = "unknown"

    async def fetch_listings(self) -> list[dict]:
        """Fetch and return normalized job dicts. Override in subclasses."""
        raise NotImplementedError

    @staticmethod
    def strip_html(html: str) -> str:
        """Convert HTML to clean plain text."""
        if not html:
            return ""
        soup = BeautifulSoup(html, "html.parser")
        text = soup.get_text(separator="\n", strip=True)
        # Decode HTML entities (&nbsp; -> space, &amp; -> &, etc.)
        text = html_module.unescape(text)
        # Collapse multiple whitespace/newlines
        text = re.sub(r'[ \t]+', ' ', text)
        text = re.sub(r'\n{3,}', '\n\n', text)
        return text.strip()

    @staticmethod
    def detect_remote(title: str, location: str, description: str) -> bool:
        """Check if a job is remote based on title, location, and description."""
        text = f"{title} {location} {description}".lower()
        remote_signals = ["remote", "work from home", "wfh", "distributed", "anywhere"]
        return any(s in text for s in remote_signals)

    @staticmethod
    def parse_salary(text: str) -> tuple[int | None, int | None]:
        """Extract salary range from text. Returns (min, max) or (None, None)."""
        if not text:
            return None, None

        # Match patterns like $100,000 - $150,000 or $100K-$150K
        pattern = r'\$\s*([\d,]+)\s*[kK]?\s*(?:[-\u2013to]+\s*\$?\s*([\d,]+)\s*[kK]?)?'
        match = re.search(pattern, text)
        if not match:
            return None, None

        def parse_amount(s: str) -> int | None:
            if not s:
                return None
            cleaned = s.replace(",", "")
            val = int(cleaned)
            # Only treat as shorthand if it looks like a real salary (e.g., 120K = $120,000)
            # Values like $500 are stipends/bonuses, not salaries
            if 50 <= val < 1000:
                val *= 1000
            return val

        salary_min = parse_amount(match.group(1))
        salary_max = parse_amount(match.group(2)) if match.group(2) else salary_min

        # Sanity check: filter out non-salary amounts
        if salary_min and salary_min < 20000:
            return None, None
        if salary_min and salary_min > 400000:
            return None, None
        if salary_max and salary_max > 500000:
            return None, None

        return salary_min, salary_max

    @staticmethod
    def make_external_id(source: str, *parts: str) -> str:
        """Generate a stable external ID from source and identifying parts."""
        raw = f"{source}_{'_'.join(str(p) for p in parts)}"
        return hashlib.md5(raw.encode()).hexdigest()[:16]

    @staticmethod
    def now_utc() -> datetime:
        return datetime.now(timezone.utc)