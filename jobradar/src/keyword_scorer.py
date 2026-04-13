"""
Keyword-based JD scoring engine.

Parses job descriptions, extracts weighted requirements, matches against
a candidate profile and accomplishments DB, decodes euphemisms, detects role type,
and calculates a 0-100 match score. Pure Python, no LLM needed.
"""

import re
import yaml
from pathlib import Path
from collections import Counter

from scoring.db_helper import fts_search
from scoring.profile_loader import load_profile, get_role_emphasis

# Title patterns that indicate non-target roles (engineering, sales, design, etc.)
REJECT_TITLE_PATTERNS = [
    re.compile(p, re.IGNORECASE) for p in [
        r'\bsoftware engineer', r'\bdata engineer', r'\bsre\b',
        r'\bdevops engineer', r'\bfrontend developer', r'\bbackend developer',
        r'\bmachine learning engineer', r'\bplatform engineer',
        r'\bsite reliability', r'\bfull.?stack developer',
        r'\bios developer', r'\bandroid developer', r'\bstaff engineer',
        r'\bprincipal engineer', r'\bengineering manager',
        r'\bdata scientist', r'\bux designer', r'\bui designer',
        r'\baccount executive', r'\bsales rep', r'\bbdr\b', r'\bsdr\b',
        r'\bsecurity engineer', r'\binfrastructure engineer',
        r'\bqa engineer', r'\btest engineer', r'\bembedded engineer',
        r'\bfirmware engineer', r'\bcloud engineer', r'\bnetwork engineer',
        r'\bsystems administrator', r'\bdatabase administrator',
        r'\bgraphic designer', r'\bvisual designer', r'\bmotion designer',
        r'\bcopywriter\b', r'\bcontent writer\b',
        r'\brecruiter\b', r'\btalent acquisition',
        r'\blegal counsel', r'\bparalegal', r'\baccountant\b', r'\bbookkeeper',
        r'\bcustomer support', r'\bcustomer service rep',
        r'\bfullstack engineer', r'\bfull.?stack engineer',
        r'\bproduct designer', r'\bsenior designer',
        r'\bfinancial analyst', r'\bcontroller\b',
        r'\bnurse\b', r'\bphysician\b', r'\bclinician\b', r'\btherapist\b',
        r'\bteacher\b', r'\binstructor\b',
    ]
]


def title_screen(title: str) -> dict:
    """
    Fast title-based screening. Rejects obviously wrong role types
    before any expensive analysis runs.

    Returns:
        {"pass": True/False, "reason": str}
    """
    if not title:
        return {"pass": True, "reason": "No title to screen"}

    for pattern in REJECT_TITLE_PATTERNS:
        if pattern.search(title):
            return {"pass": False, "reason": f"Title '{title}' matches reject pattern"}

    return {"pass": True, "reason": "Title passed screening"}

# Load euphemisms database
DATA_DIR = Path(__file__).parent.parent / "data"
_euphemisms_path = DATA_DIR / "euphemisms.yaml"
if _euphemisms_path.exists():
    with open(_euphemisms_path, "r", encoding="utf-8") as f:
        EUPHEMISMS_DB = yaml.safe_load(f)
else:
    EUPHEMISMS_DB = {"euphemisms": []}

# Common stop words for keyword extraction
STOP_WORDS = {
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "had", "her",
    "was", "one", "our", "out", "has", "have", "been", "some", "them", "than",
    "its", "over", "such", "that", "this", "with", "will", "each", "from",
    "they", "been", "said", "what", "when", "who", "how", "into", "more",
    "other", "about", "these", "their", "which", "would", "there", "where",
    "could", "being", "should", "through", "before", "after", "between",
    "your", "like", "make", "take", "come", "keep", "find", "give", "most",
    "need", "want", "does", "just", "much", "very", "only", "both", "then",
    "than", "even", "here", "must", "while", "every",
    "work", "role", "team", "ability", "looking", "ideal", "candidate",
    "strong", "experience", "including", "ensure", "also", "well",
    "required", "preferred", "similar", "minimum", "plus", "bonus", "nice",
    "familiarity", "knowledge", "understanding", "proven", "demonstrated",
    "extensive", "excellent", "mindset", "comfort", "comfortable",
    "environment", "scale", "growing", "fast-paced", "years",
    "proficiency", "track", "record", "skilled", "competent",
    "ability", "capable", "deep", "solid", "relevant", "related",
    "responsible", "duties", "responsibilities", "qualifications",
    "offers", "offer", "company", "apply", "position", "opportunity",
    "ambiguity", "nurture", "sequences", "desire", "desired",
    "thrive", "passion", "passionate", "enthusiasm", "enthusiastic",
    "dynamic", "leverage", "utilize", "synergy", "catalyze",
    "skills", "analytical", "data-driven", "detail-oriented",
    "platform", "tools", "services",
    # HTML artifacts that leak through strip_html
    "nbsp", "span", "class", "style", "href", "http", "https",
    "www", "div", "strong", "content", "intro", "color",
    "font", "size", "padding", "margin", "height", "width",
    "border", "none", "block", "inline", "display",
    "base", "salary", "range", "added",
}

# Section header patterns for JD parsing
SECTION_PATTERNS = {
    "responsibilities": re.compile(
        r'(?:^|\n)\s*(?:#+\s*)?(?:what you\'?ll do|responsibilities|'
        r'key responsibilities|the role|about the role|'
        r'what you will do|your role|job duties|duties)\s*[:.]?\s*(?:\n|$)',
        re.IGNORECASE
    ),
    "requirements": re.compile(
        r'(?:^|\n)\s*(?:#+\s*)?(?:requirements|qualifications|'
        r'what we\'?re looking for|what you bring|'
        r'must have|minimum qualifications|required|'
        r'who you are|about you|what you need)\s*[:.]?\s*(?:\n|$)',
        re.IGNORECASE
    ),
    "preferred": re.compile(
        r'(?:^|\n)\s*(?:#+\s*)?(?:preferred|nice to have|bonus|'
        r'preferred qualifications|ideal|plus|'
        r'additional|desired)\s*[:.]?\s*(?:\n|$)',
        re.IGNORECASE
    ),
    "about_company": re.compile(
        r'(?:^|\n)\s*(?:#+\s*)?(?:about us|about \w+|who we are|'
        r'our company|company overview|about the company)\s*[:.]?\s*(?:\n|$)',
        re.IGNORECASE
    ),
    "benefits": re.compile(
        r'(?:^|\n)\s*(?:#+\s*)?(?:benefits|compensation|perks|'
        r'what we offer|salary|total rewards)\s*[:.]?\s*(?:\n|$)',
        re.IGNORECASE
    ),
}

# Role-type keyword sets for auto-detection
ROLE_TYPE_KEYWORDS = {
    "revops": {"revenue", "data", "analytics", "pipeline", "forecasting", "salesforce",
               "hubspot", "crm", "dashboard", "reporting", "metrics", "automation",
               "integration", "database", "etl", "bi", "sql"},
    "marops": {"marketing", "email", "campaign", "content", "seo", "analytics",
               "automation", "hubspot", "marketo", "pardot", "mailchimp",
               "a/b testing", "conversion", "demand generation", "brand"},
    "bizops": {"operations", "process", "efficiency", "vendor", "procurement",
               "cross-functional", "project management", "workflow", "documentation",
               "budget", "planning", "strategy", "optimization"},
    "director": {"leadership", "strategy", "team", "budget", "executive",
                 "department", "organizational", "vision", "kpi", "growth",
                 "p&l", "headcount", "roadmap"},
    "tpm": {"program", "stakeholder", "timeline", "milestone", "requirements",
            "sprint", "agile", "scrum", "release", "coordination", "dependencies",
            "risk", "specification", "technical"},
    "solutions_engineer": {"solutions", "demo", "technical sales", "pre-sales",
                           "implementation", "customer success", "onboarding",
                           "proof of concept", "customer facing", "technical account"},
}


def parse_sections(jd_text):
    """Parse JD into logical sections based on header detection."""
    sections = []
    boundaries = []
    for section_type, pattern in SECTION_PATTERNS.items():
        for match in pattern.finditer(jd_text):
            boundaries.append((match.start(), match.end(), section_type))

    boundaries.sort(key=lambda x: x[0])

    if not boundaries:
        return [{"type": "general", "text": jd_text}]

    if boundaries[0][0] > 0:
        sections.append({"type": "intro", "text": jd_text[:boundaries[0][0]].strip()})

    for i, (start, end, section_type) in enumerate(boundaries):
        next_start = boundaries[i + 1][0] if i + 1 < len(boundaries) else len(jd_text)
        text = jd_text[end:next_start].strip()
        if text:
            sections.append({"type": section_type, "text": text})

    return sections


def extract_requirements(sections):
    """Extract individual requirements from parsed sections with weighting."""
    requirements = []
    total_length = sum(len(s["text"]) for s in sections)
    cumulative_pos = 0

    for section in sections:
        if section["type"] in ("about_company", "benefits"):
            cumulative_pos += len(section["text"])
            continue

        text = section["text"]
        items = re.findall(r'(?:^|\n)\s*[-*\u2022]\s*(.+?)(?=\n|$)', text)
        if not items:
            items = re.split(r'[.\n]', text)
            items = [i.strip() for i in items if len(i.strip()) > 20]

        for item in items:
            item = item.strip()
            if len(item) < 10:
                continue

            item_lower = item.lower()
            if section["type"] == "preferred":
                req_type = "preferred"
            elif any(w in item_lower for w in ["must have", "required", "minimum"]):
                req_type = "hard"
            elif any(w in item_lower for w in ["preferred", "nice to have", "bonus", "plus", "ideal"]):
                req_type = "preferred"
            else:
                req_type = "hard" if section["type"] == "requirements" else "standard"

            position = cumulative_pos / total_length if total_length > 0 else 0.5
            position_score = 1.0 - position

            section_scores = {
                "requirements": 1.0, "responsibilities": 0.8,
                "intro": 0.6, "preferred": 0.3, "general": 0.5
            }
            section_score = section_scores.get(section["type"], 0.5)

            type_modifier = {"hard": 1.0, "standard": 0.7, "preferred": 0.3}
            type_score = type_modifier.get(req_type, 0.5)

            raw_weight = (position_score * 0.3 + section_score * 0.4 + type_score * 0.3) * 10
            weight = max(1, min(10, round(raw_weight)))

            requirements.append({
                "text": item,
                "type": req_type,
                "weight": weight,
                "section": section["type"],
            })

        cumulative_pos += len(section["text"])

    # Boost weight for repeated concepts
    all_text = " ".join(r["text"].lower() for r in requirements)
    for req in requirements:
        key_terms = set(re.findall(r'\b[a-z]{4,}\b', req["text"].lower())) - STOP_WORDS
        repetitions = sum(1 for t in key_terms if all_text.count(t) > 1)
        if repetitions >= 2:
            req["weight"] = min(10, req["weight"] + 1)

    return sorted(requirements, key=lambda x: x["weight"], reverse=True)


def match_requirements(requirements, profile=None, db_path=None):
    """Match each requirement against the candidate profile and accomplishments DB."""
    if profile is None:
        profile = load_profile()

    # Build a text blob of the candidate profile for matching
    # [Profile data removed -- structured YAML with experience, systems, and role emphasis]
    profile_text = ""
    for role_data in profile.get("experience", []):
        for role in role_data.get("roles", []):
            for group in role.get("groups", []):
                for bullet in group.get("bullets", []):
                    profile_text += " " + bullet.get("text", "")
            for bullet in role.get("bullets", []):
                if isinstance(bullet, dict):
                    profile_text += " " + bullet.get("text", "")
    for system in profile.get("systems", []):
        profile_text += " " + system.get("description", "")
    for key, val in profile.get("skills", {}).items():
        profile_text += " " + str(val)

    profile_lower = profile_text.lower()

    for req in requirements:
        req_lower = req["text"].lower()
        key_terms = set(re.findall(r'\b[a-z]{4,}\b', req_lower)) - STOP_WORDS

        profile_hits = sum(1 for t in key_terms if t in profile_lower)
        match_ratio = profile_hits / len(key_terms) if key_terms else 0

        evidence = []
        try:
            search_terms = list(key_terms)[:3]
            if search_terms:
                query = " OR ".join(search_terms)
                results = fts_search(query, limit=3, db_path=db_path)
                evidence = [r["clean_text"][:100] for r in results]
        except Exception:
            pass

        if match_ratio >= 0.5 or (evidence and match_ratio >= 0.3):
            match = "strong"
        elif match_ratio >= 0.2 or evidence:
            match = "moderate"
        elif match_ratio > 0:
            match = "bridge"
        else:
            match = "gap"

        req["match"] = match
        req["match_ratio"] = round(match_ratio, 2)
        req["evidence"] = evidence[:2]

    return requirements


def decode_euphemisms(jd_text):
    """Match JD text against euphemism database."""
    decoded = []
    jd_lower = jd_text.lower()

    for entry in EUPHEMISMS_DB.get("euphemisms", []):
        for phrase in entry.get("phrases", []):
            if phrase.lower() in jd_lower:
                decoded.append({
                    "phrase": phrase,
                    "meaning": entry["meaning"],
                    "candidate_fit": entry["candidate_fit"],
                })
                break

    return decoded


def extract_keywords(jd_text, requirements):
    """Extract top 20 keywords for ATS targeting."""
    jd_lower = jd_text.lower()

    company_words = set()
    about_match = re.search(r'(?:about|at)\s+([A-Z][\w\s&.]+?)(?:\s*\n|$)', jd_text)
    if about_match:
        company_words = set(about_match.group(1).lower().split())

    words = re.findall(r'\b[a-z][a-z-]+\b', jd_lower)
    words = [w for w in words if w not in STOP_WORDS and len(w) > 3 and w not in company_words]

    bigrams = []
    word_list = jd_lower.split()
    for i in range(len(word_list) - 1):
        w1 = re.sub(r'[^\w-]', '', word_list[i])
        w2 = re.sub(r'[^\w-]', '', word_list[i + 1])
        if (w1 not in STOP_WORDS and w2 not in STOP_WORDS
                and len(w1) > 2 and len(w2) > 2
                and w1 not in company_words and w2 not in company_words):
            bigrams.append(f"{w1} {w2}")

    word_freq = Counter(words)
    bigram_freq = Counter(bigrams)

    for req in requirements:
        if req.get("section") == "requirements" or req.get("type") == "hard":
            req_words = re.findall(r'\b[a-z][a-z-]+\b', req["text"].lower())
            for w in req_words:
                if w not in STOP_WORDS and len(w) > 3:
                    word_freq[w] += 3

    domain_terms = {
        "automation", "dashboard", "reporting", "analytics", "pipeline",
        "integration", "workflow", "segmentation", "campaigns", "cross-functional",
        "operations", "marketing", "email", "vendor", "stakeholder",
        "coordination", "process", "documentation", "compliance",
        "hubspot", "salesforce", "marketo", "moosend", "monday",
    }
    for term in domain_terms:
        if term in word_freq:
            word_freq[term] += 2

    all_terms = {}
    for bigram, count in bigram_freq.most_common(30):
        if count >= 2:
            all_terms[bigram] = count * 3
    for word, count in word_freq.most_common(40):
        already_in_bigram = any(word in bg for bg in all_terms)
        if not already_in_bigram:
            all_terms[word] = count

    sorted_terms = sorted(all_terms.items(), key=lambda x: x[1], reverse=True)
    return [term for term, _ in sorted_terms[:20]]


def detect_role_type(jd_text, requirements):
    """Auto-detect which role type framing to use."""
    jd_lower = jd_text.lower()
    scores = {}

    for role_type, keywords in ROLE_TYPE_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw in jd_lower)
        scores[role_type] = score

    best_type = max(scores, key=scores.get) if scores else "bizops"
    return best_type, scores


def detect_red_flags(jd_text):
    """Scan for red flags that indicate poor fit."""
    flags = []
    jd_lower = jd_text.lower()

    # Configurable salary floor -- set via SALARY_MINIMUM in config
    SALARY_MINIMUM = 80000  # Configure for your target salary
    salary_match = re.search(r'\$(\d[\d,]*)', jd_text)
    if salary_match:
        amount = int(salary_match.group(1).replace(",", ""))
        if amount < SALARY_MINIMUM and amount > 10000:
            flags.append(f"Listed salary ${amount:,} is below ${SALARY_MINIMUM:,} minimum")

    for platform in ["hubspot", "salesforce", "marketo", "pardot"]:
        if re.search(rf'(?:must have|required|minimum).*\d+\+?\s*years?\s*(?:of\s+)?{platform}', jd_lower):
            flags.append(f"Hard requirement for {platform} experience")

    if re.search(r'(?:must have|required)\s+(?:bachelor|master|phd|mba)', jd_lower):
        flags.append("Hard degree requirement")

    if "on-site" in jd_lower or "in-office" in jd_lower:
        if "remote" not in jd_lower and "hybrid" not in jd_lower:
            flags.append("Appears to be on-site only")

    bullet_count = len(re.findall(r'(?:^|\n)\s*[-*\u2022]', jd_text))
    if bullet_count > 20:
        flags.append(f"Overloaded role: {bullet_count} requirements listed")

    # Large company detection
    emp_match = re.search(r'(\d[\d,]*)\+?\s*employees', jd_lower)
    if emp_match:
        emp_count = int(emp_match.group(1).replace(",", ""))
        if emp_count > 1000:
            flags.append(f"Large company ({emp_count:,} employees) -- competitive applicant pool")

    return flags


def detect_green_flags(jd_text):
    """Scan for positive signals that indicate strong fit."""
    flags = []
    jd_lower = jd_text.lower()

    builder_phrases = [
        ("build from scratch", "Build from scratch / greenfield"),
        ("greenfield", "Build from scratch / greenfield"),
        ("first hire", "First hire for this function"),
        ("define the function", "Define the function from zero"),
        ("zero to one", "Zero to one / ground up"),
        ("ground up", "Zero to one / ground up"),
    ]
    for phrase, label in builder_phrases:
        if phrase in jd_lower:
            flags.append(label)
            break  # One builder flag is enough

    ambiguity_phrases = ["comfort with ambiguity", "comfortable with ambiguity", "figure it out", "wear many hats"]
    if any(p in jd_lower for p in ambiguity_phrases):
        flags.append("Values ambiguity tolerance / generalist mindset")

    funding_match = re.search(r'\bseries [a-c]\b', jd_lower)
    if funding_match:
        flags.append(f"Growth stage ({funding_match.group().title()} funding)")

    mission_phrases = ["healthcare", "education", "climate", "open source", "social impact"]
    for phrase in mission_phrases:
        if phrase in jd_lower:
            flags.append(f"Mission-aligned ({phrase})")
            break

    ai_build_phrases = ["build.*ai", "ai.*automation", "implement.*ai", "deploy.*ai", "leverage ai"]
    if any(re.search(p, jd_lower) for p in ai_build_phrases):
        flags.append("AI/automation as a building requirement")

    autonomy_phrases = ["high autonomy", "ownership", "builder culture", "high agency"]
    if any(p in jd_lower for p in autonomy_phrases):
        flags.append("Builder / autonomy culture signal")

    return flags


def analyze_jd(jd_text, profile=None, db_path=None):
    """
    Full JD analysis. Returns structured dict with match_score (0-100),
    role_type, red_flags, top_keywords, requirements breakdown.
    """
    if not jd_text or len(jd_text.strip()) < 50:
        return {"match_score": 0, "role_type": "unknown", "red_flags": [],
                "top_keywords": [], "total_requirements": 0, "strong_matches": 0,
                "moderate_matches": 0, "gap_count": 0}

    if profile is None:
        profile = load_profile()

    sections = parse_sections(jd_text)
    requirements = extract_requirements(sections)
    requirements = match_requirements(requirements, profile, db_path)
    euphemisms = decode_euphemisms(jd_text)
    keywords = extract_keywords(jd_text, requirements)
    role_type, role_scores = detect_role_type(jd_text, requirements)
    red_flags = detect_red_flags(jd_text)
    green_flags = detect_green_flags(jd_text)

    # Calculate match score
    if requirements:
        weighted_sum = sum(
            r["weight"] * {"strong": 1.0, "moderate": 0.7, "bridge": 0.4, "gap": 0.0}[r["match"]]
            for r in requirements
        )
        weight_total = sum(r["weight"] for r in requirements)
        match_score = round(weighted_sum / weight_total * 100) if weight_total > 0 else 0
    else:
        match_score = 0

    gaps = [
        r for r in requirements
        if r["match"] in ("gap", "bridge") and r["weight"] >= 5
        and len(re.sub(r'[^a-zA-Z\s]', '', r["text"]).strip()) >= 20  # Filter HTML garbage
    ]

    return {
        "role_type": role_type,
        "role_type_scores": role_scores,
        "match_score": match_score,
        "top_keywords": keywords,
        "euphemisms_decoded": euphemisms,
        "red_flags": red_flags,
        "green_flags": green_flags,
        "gaps": [{"text": g["text"][:200], "weight": g["weight"]} for g in gaps[:10]],
        "sections_found": [s["type"] for s in sections],
        "total_requirements": len(requirements),
        "strong_matches": sum(1 for r in requirements if r["match"] == "strong"),
        "moderate_matches": sum(1 for r in requirements if r["match"] == "moderate"),
        "gap_count": sum(1 for r in requirements if r["match"] == "gap"),
    }