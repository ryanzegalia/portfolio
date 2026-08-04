"""Build templates/platform_map.html from platform_map/fragments/*.json.

The generated template is NEVER edited by hand. Sources of truth:
  - platform_map/template.html          the page shell (Jinja, extends base)
  - platform_map/hub.json               the center node's modal (business
        register, no counts of tables/routes/tools -- those live as the
        homepage card's footnote). Ryan, 2026-08-03: "this isn't a technical
        walk through."
  - platform_map/fragments/<id>.json    one system each, business-first
        (Ryan, round 3): {id, title, card, what, problem, result,
        how: [paragraphs]}. "card" is the single outcome line the cluster
        card shows; "how" is the tech detail and renders last and secondary.
        Optional "shot": {src, alt, caption?} -- a screenshot of the running
        system. src is a bare filename under static/img/systems/. A system
        without one is normal; several of these have no UI to photograph.
        Optional "github": a deep link to this system's SPECIFIC document.
        A bare stem targets nexus/case-studies/<stem>.md (the original nine,
        Ryan 2026-08-03); "components/<stem>" targets nexus/components/
        (approved 2026-08-03 for twelve more). Cards with neither carry
        nothing, because a generic "see GitHub" teaches a reader the link is
        not worth a click. The target file must exist or the build fails.
  - ROSTER below                        the map: the groups and their systems

System and group COUNTS are never typed into copy. The hero and the hub lede
carry __SYSTEM_COUNT__ / __GROUP_COUNT_WORD__ placeholders that this script
fills from ROSTER, because the hero shipped "Twenty-three systems" for three
days after the roster reached 26.

The page is the SPOKE MAP of the revenue operations platform ONLY (Ryan,
2026-07-27): hub + five groups around it, in the site's light theme. Personal
production and the demos live on the homepage, never here. Held copy for
those nodes sits in platform_map/fragments-held/ (excluded from the build).

Run:  python scripts/build_platform_map.py
Lint BLOCKS (exit 1): non-ASCII anywhere, a banned identifier (the employer,
product and codename strings, loaded from outside this file -- see
load_banned() and scripts/README.md), Jinja delimiters in fragment text,
roster/fragment mismatch. The lint is the mechanical floor, never the
editorial bar.
"""
import hashlib
import html
import json
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FRAG_DIR = REPO / "platform_map" / "fragments"
TEMPLATE = REPO / "platform_map" / "template.html"
HUB_FILE = REPO / "platform_map" / "hub.json"
SHOT_DIR = REPO / "static" / "img" / "systems"
SHOT_URL = "/static/img/systems/"
OUT = REPO / "templates" / "platform_map.html"

# Deep links land on a file in the sibling nexus/ tree, so a broken one is a
# build failure rather than a 404 a reader finds first. Bare stems are
# case studies; a "components/" prefix targets the component catalog.
CASE_DIR = REPO.parent / "nexus" / "case-studies"
CASE_URL = "https://github.com/ryanzegalia/portfolio/blob/main/nexus/case-studies/"
COMP_DIR = REPO.parent / "nexus" / "components"
COMP_URL = "https://github.com/ryanzegalia/portfolio/blob/main/nexus/components/"
CONN_DIR = REPO.parent / "nexus" / "connector"
CONN_URL = "https://github.com/ryanzegalia/portfolio/blob/main/nexus/connector/"
GH_FOLDERS = {"components": (COMP_DIR, COMP_URL), "connector": (CONN_DIR, CONN_URL)}

# The map: five groups around the hub, in spoke order (12 o'clock, clockwise).
# (slug, name, one-line descriptor, [system ids])
ROSTER = [
    ("data-in", "Data Ingestion",
     "The services that pull records out of the ERP and the other systems the business runs on.",
     ["erp-sync", "shipping", "excel-sync", "marketing-sync", "deal-watch"]),
    ("customer-foundation", "Customer Foundation",
     "One current copy of the customer base, resolved down to the real people behind it.",
     ["mirror", "identity", "dedupe"]),
    ("operations-tools", "Operations Tools",
     "What the warehouse, accounting, and marketing teams open to get their work done.",
     ["pricing", "tax-recon", "payment-recon", "order-desk", "qc", "fulfillment",
      "catalog", "hazmat"]),
    ("intelligence", "Intelligence and Reporting",
     "What the business can see once its data is collected in one place.",
     ["forecasting", "sales-trends", "analytics", "cart", "monitoring"]),
    ("platform-agents", "Platform and Agents",
     "What keeps everything else running, plus the layer an AI assistant works through.",
     ["agents", "write-safety", "auth", "infra", "connector"]),
]

# Fragment schema, round 3 (business-first). Order here is render order.
BLOCKS = [("problem", "The problem"), ("result", "The result"), ("how", "How it works")]

# The second slot is not always a problem (Ryan, 2026-07-28, hiring-manager
# audit). It reads as padding when the "problem" is a requirement anyone would
# have predicted: you need authentication, you need a way to query your data.
# Three honest shapes, chosen per system:
#   The problem    someone was visibly suffering and there is a number
#   The constraint something in the environment could not be changed, and the
#                  work is what was engineered around it
#   Why it exists  the reason it had to be built, where the interesting part is
#                  the decision rather than any pain
PROBLEM_LABELS = {"The problem", "The constraint", "Why it exists"}

def load_banned():
    """Terms the map must never render, loaded from OUTSIDE this file.

    This repository is published. A literal list of the employer, product and
    codename strings would hand any reader the exact mapping the map exists to
    avoid -- the list of words you are hiding identifies them just as well as
    using them does. So the terms live in scripts/banned_terms.local, which is
    gitignored, or in PORTFOLIO_BANNED_TERMS as a comma-separated string.
    See scripts/banned_terms.example for the shape.

    Word-boundary and case-insensitive at the call site, so a term like
    "elevate" still lets "elevated" through.
    """
    raw = os.environ.get("PORTFOLIO_BANNED_TERMS", "")
    if not raw:
        local = Path(__file__).resolve().parent / "banned_terms.local"
        if local.exists():
            raw = ",".join(local.read_text(encoding="utf-8").split())
    terms = [t.strip() for t in raw.replace("\n", ",").split(",") if t.strip()]
    if not terms:
        print("WARNING: no banned-term list configured, so the identifier lint "
              "is INACTIVE. Copy scripts/banned_terms.example to "
              "scripts/banned_terms.local (or set PORTFOLIO_BANNED_TERMS) "
              "before trusting this build.", file=sys.stderr)
    return terms


def _term_pattern(term):
    """A trailing '*' means prefix match, so one entry covers a word family."""
    if term.endswith("*"):
        return re.escape(term[:-1]) + r"\w*"
    return re.escape(term)


BANNED = load_banned()
# None, not an empty alternation: "\b()\b" matches every word boundary, which
# would fail the build on its first word instead of letting it through.
BANNED_RE = (re.compile(r"\b(" + "|".join(_term_pattern(t) for t in BANNED) + r")\b",
                        re.IGNORECASE)
             if BANNED else None)
# (the personal-project word family moved into the local term list as "<name>*")
JINJA_RE = re.compile(r"\{\{|\{%|%\}|\}\}")
SHOT_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*\.(png|jpg|jpeg|webp)$")
CASE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")

# Counts appear in copy as words, in the register's own style ("Twenty-three
# systems"), so the substitution has to produce the word and not a numeral.
NUMBER_WORDS = {
    1: "One", 2: "Two", 3: "Three", 4: "Four", 5: "Five", 6: "Six",
    7: "Seven", 8: "Eight", 9: "Nine", 10: "Ten", 11: "Eleven", 12: "Twelve",
    13: "Thirteen", 14: "Fourteen", 15: "Fifteen", 16: "Sixteen",
    17: "Seventeen", 18: "Eighteen", 19: "Nineteen", 20: "Twenty",
    21: "Twenty-one", 22: "Twenty-two", 23: "Twenty-three",
    24: "Twenty-four", 25: "Twenty-five", 26: "Twenty-six",
    27: "Twenty-seven", 28: "Twenty-eight", 29: "Twenty-nine", 30: "Thirty",
}


def number_word(n: int) -> str:
    """The count as a word, or the numeral if the map outgrows the table."""
    return NUMBER_WORDS.get(n, str(n))


def fill_counts(text: str, n_systems: int, n_groups: int) -> str:
    return (text
            .replace("__SYSTEM_COUNT_WORD__", number_word(n_systems))
            .replace("__SYSTEM_COUNT__", str(n_systems))
            .replace("__GROUP_COUNT_WORD__", number_word(n_groups))
            .replace("__GROUP_COUNT__", str(n_groups)))


def asset_version(path: Path) -> str:
    """Content hash for a ?v= on an image URL.

    filters.STATIC_VERSION hashes the stylesheets only, so a re-captured
    screenshot would otherwise be served from cache forever. Same class of
    bug that shipped a stale unstyled page during the 2026-07-27 review.
    """
    return hashlib.sha256(path.read_bytes()).hexdigest()[:10]


def png_size(path: Path) -> tuple[int, int] | None:
    """(width, height) off a PNG header, so the image reserves its box.

    Without intrinsic dimensions the modal reflows when the screenshot
    decodes, which reads as a page still loading.
    """
    head = path.read_bytes()[:24]
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")


def lint_shot(node_id: str, shot: object, errors: list) -> dict | None:
    """Validate an optional screenshot block. Returns the cleaned dict."""
    if not isinstance(shot, dict):
        errors.append(f"{node_id}.json: shot must be an object {{src, alt, caption?}}")
        return None
    src = shot.get("src")
    alt = shot.get("alt")
    if not isinstance(src, str) or not SHOT_NAME_RE.match(src):
        errors.append(f"{node_id}.json: shot.src must be a bare filename under "
                      f"static/img/systems/ (got {src!r})")
        return None
    if not isinstance(alt, str) or not alt.strip():
        errors.append(f"{node_id}.json: shot.alt is required -- it is the only "
                      f"description in the no-JS reader")
        return None
    path = SHOT_DIR / src
    if not path.is_file():
        errors.append(f"{node_id}.json: shot.src not on disk: {path}")
        return None
    caption = shot.get("caption")
    if caption is not None and (not isinstance(caption, str) or not caption.strip()):
        errors.append(f"{node_id}.json: shot.caption must be a non-empty string or absent")
        return None
    # alt and caption are public copy: same ASCII / banned-name floor as the rest
    lint_text(node_id, "shot.alt", alt, errors)
    if caption:
        lint_text(node_id, "shot.caption", caption, errors)
    return {
        "src": src,
        "alt": alt.strip(),
        "caption": caption.strip() if caption else "",
        "v": asset_version(path),
        "size": png_size(path),
    }


def lint_github(node_id: str, stem: object, errors: list) -> str:
    """Validate an optional deep link. Returns the cleaned value.

    A bare stem is a case study; a "components/<stem>" value is a component
    doc. The document has to exist. A card that promises a specific writeup
    and lands on a 404 costs more than the links buy, and the reader who
    clicks it is the one most worth keeping.
    """
    if not isinstance(stem, str):
        errors.append(f"{node_id}.json: github must be a string (got {stem!r})")
        return ""
    folder, name = (stem.split("/", 1) + [""])[:2] if "/" in stem else ("case-studies", stem)
    valid_folder = folder == "case-studies" or folder in GH_FOLDERS
    valid_name = re.match(r"^[A-Za-z0-9][A-Za-z0-9-]*$", name) is not None
    if not (valid_folder and valid_name):
        errors.append(f"{node_id}.json: github must be a filename stem, "
                      f"components/<stem>, or connector/<stem> (got {stem!r})")
        return ""
    target_dir = GH_FOLDERS[folder][0] if folder in GH_FOLDERS else CASE_DIR
    if not (target_dir / f"{name}.md").is_file():
        errors.append(f"{node_id}.json: github target not on disk: "
                      f"{target_dir / (name + '.md')}")
        return ""
    return stem


def lint_text(node_id: str, field: str, text: str, errors: list) -> None:
    for ch in text:
        if ord(ch) > 127:
            errors.append(f"{node_id}.{field}: non-ASCII U+{ord(ch):04X} in {text[:60]!r}")
            break
    m = BANNED_RE.search(text) if BANNED_RE else None
    if m:
        errors.append(f"{node_id}.{field}: banned identifier {m.group(0)!r}")
    if JINJA_RE.search(text):
        errors.append(f"{node_id}.{field}: Jinja delimiter in fragment text")


def load_fragments() -> tuple[dict, list]:
    errors = []
    wanted = [nid for _, _, _, ids in ROSTER for nid in ids]
    dupes = {x for x in wanted if wanted.count(x) > 1}
    if dupes:
        errors.append(f"roster lists duplicate ids: {sorted(dupes)}")

    frags = {}
    on_disk = {p.stem: p for p in sorted(FRAG_DIR.glob("*.json"))}
    for nid in wanted:
        if nid not in on_disk:
            errors.append(f"missing fragment: {nid}.json")
    for stem in on_disk:
        if stem not in wanted:
            errors.append(f"fragment not in roster: {stem}.json (hold it in fragments-held/)")
    if errors:
        return frags, errors

    for nid, path in on_disk.items():
        try:
            f = json.loads(path.read_text(encoding="ascii"))
        except UnicodeDecodeError:
            errors.append(f"{nid}.json: non-ASCII bytes")
            continue
        except json.JSONDecodeError as e:
            errors.append(f"{nid}.json: bad JSON ({e})")
            continue
        if f.get("id") != nid:
            errors.append(f"{nid}.json: id field {f.get('id')!r} != filename")
        bad = False
        # problem and result are OPTIONAL (Ryan, 2026-07-28): forcing a
        # business-pain paragraph onto a system that has no interesting one is
        # how filler gets written, and 23 pieces in the same four slots is the
        # formula-stamping the plan already bans. A piece may be just what it
        # is and how it works.
        for field in ("title", "card", "what"):
            if not isinstance(f.get(field), str) or not f[field].strip():
                errors.append(f"{nid}.json: missing {field}")
                bad = True
        for field in ("problem", "result"):
            if field in f and (not isinstance(f[field], str) or not f[field].strip()):
                errors.append(f"{nid}.json: {field} present but empty -- omit the key instead")
                bad = True
        label = f.get("problem_label")
        if label is not None and label not in PROBLEM_LABELS:
            errors.append(f"{nid}.json: problem_label {label!r} not one of {sorted(PROBLEM_LABELS)}")
            bad = True
        if label and not f.get("problem"):
            errors.append(f"{nid}.json: problem_label set but there is no problem text to label")
            bad = True
        how = f.get("how")
        if not isinstance(how, list) or not how or not all(isinstance(p, str) and p.strip() for p in how):
            errors.append(f"{nid}.json: how must be a non-empty list of paragraphs")
            bad = True
        if "body" in f or "signals" in f:
            errors.append(f"{nid}.json: round-2 schema (body/signals) -- rewrite as card/what/problem/result/how")
            bad = True
        if bad:
            continue
        for field in ("title", "card", "what"):
            lint_text(nid, field, f[field], errors)
        for field in ("problem", "result"):
            if f.get(field):
                lint_text(nid, field, f[field], errors)
        for i, p in enumerate(how):
            lint_text(nid, f"how[{i}]", p, errors)
        shot = lint_shot(nid, f["shot"], errors) if f.get("shot") is not None else None
        gh = lint_github(nid, f["github"], errors) if f.get("github") is not None else ""
        frags[nid] = {
            "title": f["title"].strip(),
            "card": f["card"].strip(),
            "what": f["what"].strip(),
            "problem": f["problem"].strip() if f.get("problem") else "",
            "problem_label": f.get("problem_label") or "The problem",
            "result": f["result"].strip() if f.get("result") else "",
            "how": [p.strip() for p in how],
            "shot": shot,
            "github": gh,
        }
    return frags, errors


def load_hub(n_systems: int, n_groups: int) -> tuple[dict, list]:
    """The center node's modal copy. Same ASCII / banned-identifier floor.

    It is not a fragment: it has no roster slot, no screenshot and no
    problem/result shape, and it is deliberately in the business register
    while every system card carries first-person authorship.
    """
    errors = []
    try:
        h = json.loads(HUB_FILE.read_text(encoding="ascii"))
    except UnicodeDecodeError:
        return {}, [f"{HUB_FILE.name}: non-ASCII bytes"]
    except json.JSONDecodeError as e:
        return {}, [f"{HUB_FILE.name}: bad JSON ({e})"]

    for field in ("title", "eyebrow", "lede"):
        if not isinstance(h.get(field), str) or not h[field].strip():
            errors.append(f"hub.json: missing {field}")
    v = h.get("body")
    if not isinstance(v, list) or not v or not all(isinstance(p, str) and p.strip() for p in v):
        errors.append("hub.json: body must be a non-empty list of strings")
    ctas = h.get("ctas")
    if not isinstance(ctas, list) or not ctas:
        errors.append("hub.json: ctas must be a non-empty list of {label, href}")
        ctas = []
    for i, c in enumerate(ctas):
        if not isinstance(c, dict) or not c.get("label") or not c.get("href"):
            errors.append(f"hub.json: ctas[{i}] must be {{label, href}}")
    if errors:
        return {}, errors

    hub = {
        "title": fill_counts(h["title"].strip(), n_systems, n_groups),
        "eyebrow": h["eyebrow"].strip(),
        "lede": fill_counts(h["lede"].strip(), n_systems, n_groups),
        "body": [fill_counts(p.strip(), n_systems, n_groups) for p in h["body"]],
        "ctas": [{"label": c["label"].strip(), "href": c["href"].strip()} for c in ctas],
    }
    for field in ("title", "eyebrow", "lede"):
        lint_text("hub", field, hub[field], errors)
    for i, p in enumerate(hub["body"]):
        lint_text("hub", f"body[{i}]", p, errors)
    for i, c in enumerate(hub["ctas"]):
        lint_text("hub", f"ctas[{i}].label", c["label"], errors)
    return hub, errors


def shot_html(shot: dict | None) -> str:
    """A screenshot figure, or nothing. Emitted inside .map-node-body, which
    the modal copies verbatim, so one emit covers the modal, the no-JS
    reader, and the crawlable DOM."""
    if not shot:
        return ""
    e = html.escape
    dims = ""
    if shot["size"]:
        dims = f' width="{shot["size"][0]}" height="{shot["size"][1]}"'
    cap = f'\n      <figcaption>{e(shot["caption"])}</figcaption>' if shot["caption"] else ""
    return (f'    <figure class="node-shot">\n'
            f'      <img src="{SHOT_URL}{shot["src"]}?v={shot["v"]}" '
            f'alt="{e(shot["alt"])}"{dims} loading="lazy" decoding="async">'
            f'{cap}\n'
            f'    </figure>\n')


def github_html(stem: str) -> str:
    """The deep link to this system's document, or nothing.

    Emitted inside .map-node-body so the modal, the no-JS reader and the
    crawlable DOM all get it from one place, same as the screenshot.
    Case studies keep their approved link text; component docs get their own.
    """
    if not stem:
        return ""
    if "/" in stem:
        folder, name = stem.split("/", 1)
        url = GH_FOLDERS[folder][1]
        return (f'    <p class="node-source">'
                f'<a href="{url}{name}.md" rel="noopener">'
                f'Read the full writeup on GitHub</a></p>\n')
    return (f'    <p class="node-source">'
            f'<a href="{CASE_URL}{stem}.md" rel="noopener">'
            f'Read the case study on GitHub</a></p>\n')


def hub_html(hub: dict) -> str:
    """The center node's reader article. The map JS opens it as a modal.

    Outside the .reader-domain sections on purpose: the hub belongs to no
    group, and the JS derives GROUPS by walking those sections.
    """
    e = html.escape
    body = "\n".join(f"      <p>{e(p)}</p>" for p in hub["body"])
    ctas = "\n".join(
        f'      <a class="hub-cta" href="{e(c["href"])}">{e(c["label"])}</a>'
        for c in hub["ctas"])
    return f"""<article class="map-node map-hub-node" id="n-hub" data-node="hub" data-title="{e(hub["title"])}" data-eyebrow="{e(hub["eyebrow"])}">
  <h2 class="map-node-title">{e(hub["title"])}</h2>
  <div class="map-node-body">
    <p class="node-what hub-lede">{e(hub["lede"])}</p>
    <div class="node-detail">
    <div class="node-block">
{body}
    </div>
    <div class="node-block hub-ctas">
{ctas}
    </div>
    </div>
  </div>
</article>"""


def build(frags: dict, hub: dict) -> str:
    """Emit the reader DOM: one section per group, one article per system.

    This is the crawlable, no-JS-readable truth. The map JS in the template
    derives the hub/spoke/cluster views from these data attributes, and the
    drawer copies .map-node-body verbatim.
    """
    e = html.escape
    out = [hub_html(hub)]
    for slug, gname, gdesc, ids in ROSTER:
        out.append(f'<section class="reader-domain" data-group="{slug}" '
                   f'data-group-name="{e(gname)}" data-group-desc="{e(gdesc)}">')
        out.append(f'  <h2 class="reader-domain-head">{e(gname)}</h2>')
        out.append(f'  <p class="reader-domain-desc">{e(gdesc)}</p>')
        for nid in ids:
            frag = frags[nid]
            blocks = []
            for key, label in BLOCKS:
                val = frag[key]
                if not val:
                    continue  # optional slot, omitted by this system
                if key == "problem":
                    label = frag["problem_label"]
                paras = val if isinstance(val, list) else [val]
                inner = "\n      ".join(f"<p>{e(p)}</p>" for p in paras)
                cls = "node-block node-how" if key == "how" else "node-block"
                blocks.append(f'    <div class="{cls}">\n'
                              f'      <h4 class="node-block-head">{label}</h4>\n'
                              f'      {inner}\n'
                              f'    </div>')
            body = "\n".join(blocks)
            # what / shot / detail are the modal's three grid children. Keep
            # this order: stacked (narrow modal, no-JS reader) it puts the
            # screenshot directly under the one-line what, where it is seen.
            out.append(f"""  <article class="map-node" id="n-{nid}" data-node="{nid}" data-title="{e(frag["title"])}" data-card="{e(frag["card"])}">
    <h3 class="map-node-title">{e(frag["title"])}</h3>
    <div class="map-node-body">
    <p class="node-what">{e(frag["what"])}</p>
{shot_html(frag["shot"])}    <div class="node-detail">
{body}
{github_html(frag["github"])}    </div>
    </div>
  </article>""")
        out.append("</section>")
    return "\n".join(out)


def main() -> int:
    frags, errors = load_fragments()
    n_systems = sum(len(ids) for _, _, _, ids in ROSTER)
    hub, hub_errors = load_hub(n_systems, len(ROSTER))
    errors = errors + hub_errors
    if errors:
        for err in errors:
            print(f"BLOCK: {err}", file=sys.stderr)
        return 1

    shell = TEMPLATE.read_text(encoding="ascii")
    if shell.count("__MAP_CONTENT__") != 1:
        print(f"BLOCK: placeholder must appear exactly once in {TEMPLATE.name} "
              f"(found {shell.count('__MAP_CONTENT__')})", file=sys.stderr)
        return 1
    shell = fill_counts(shell, n_systems, len(ROSTER))
    content = build(frags, hub)
    banner = ("{# GENERATED by scripts/build_platform_map.py -- edit "
              "platform_map/template.html and platform_map/fragments/, "
              "then rebuild. Never edit this file. #}\n")
    page = banner + shell.replace("__MAP_CONTENT__", content)
    if "__MAP_CONTENT__" in page:
        print("BLOCK: placeholder still present after render", file=sys.stderr)
        return 1
    leftover = re.search(r"__(SYSTEM|GROUP)_COUNT(_WORD)?__", page)
    if leftover:
        print(f"BLOCK: count placeholder survived render: {leftover.group(0)}",
              file=sys.stderr)
        return 1
    page.encode("ascii")  # hard guarantee: the artifact is pure ASCII
    OUT.write_text(page, encoding="ascii")

    per =", ".join(f"{g}: {len(ids)}" for _, g, _, ids in ROSTER)
    shots = sum(1 for f in frags.values() if f["shot"])
    links = sum(1 for f in frags.values() if f["github"])
    print(f"built {OUT.relative_to(REPO)} -- {len(frags)} systems ({per})")
    print(f"screenshots: {shots}/{len(frags)}")
    print(f"deep links: {links}/{len(frags)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
