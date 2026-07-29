"""Register checker for the platform map fragments.

Ryan, 2026-07-28, on "because that is exactly the moment somebody needs to get
into it": "find other things that smell the same across all of the texts you've
written, and that should be a rule."

THE KICKER RULE
---------------
A kicker is a trailing clause that reframes what was just said for rhetorical
effect instead of adding a fact. It is the thing that makes a sentence sound
written rather than said.

THE TEST: delete the clause. If no fact was lost, it was a kicker. Cut it.

Kickers are banned because the register law already bans what they are made of:
no balanced antithesis, no punchline tails, no compressed aphorisms, no rhythm
games. Boastful is correct, but the boast is carried by plain facts and
numbers, never by phrasing.

This script cannot judge; it can only surface. It prints every marker hit and
the closing clause of every paragraph, and a human decides. Eyeballing the
whole corpus is what failed twice; reading a list of closers does not.

Run:  python scripts/check_register.py
Exit: 1 if a hard rule is broken (non-ASCII, long dash, missing authorship).
      Marker hits and closers are advisory: they need judgment.
"""
import json
import pathlib
import re
import sys
from collections import Counter

FRAG_DIR = pathlib.Path(__file__).resolve().parent.parent / "platform_map" / "fragments"

# Phrases that mark a clause written for effect. Each one is a SUSPICION, not a
# verdict: "is not an answer" is a kicker, "has no REST API" is a fact that
# happens to be negative. The reader decides.
MARKERS = [
    (r"\bwhich is exactly\b", "exactly-intensifier"),
    (r"\b(that|this) is (exactly|precisely)\b", "exactly-intensifier"),
    (r"\bexactly the (moment|thing|point|time)\b", "exactly-intensifier"),
    (r"\b(is|are|was|were) worse than\b", "comparative-aphorism"),
    (r"\ba worse (outcome|option|idea|result)\b", "comparative-aphorism"),
    (r"\b(is|are) better than\b", "comparative-aphorism"),
    (r"\b(is|are) not (an?|the) \w+", "negation-definition"),
    (r",\s+not\s+\w+", "antithesis"),
    (r"\bnobody (trusts|wants|knows|reads|believes)\b", "generalization"),
    (r"\bwas never a real\b", "rhetorical-closer"),
    (r"\bafter all of that\b", "rhetorical-beat"),
    (r"\bthe very \w+", "intensifier"),
    (r"\bat all\b", "emphasis-tail"),
    (r"\bone \w+ away from\b", "vivid-distance"),
    (r"\bits own bad\b", "flourish"),
]

# Built from code points so this source file contains no long-dash bytes of its
# own: the repo's mojibake guard blocks any file that does.
LONG_DASH = re.compile("[" + chr(0x2014) + chr(0x2013) + "]")

FIELDS = ("card", "what", "problem", "result")


def paragraphs(frag):
    for f in FIELDS:
        if frag.get(f):
            yield f, frag[f]
    for i, p in enumerate(frag.get("how", [])):
        yield f"how[{i}]", p
    shot = frag.get("shot")
    if shot:
        yield "shot.alt", shot["alt"]
        if shot.get("caption"):
            yield "shot.caption", shot["caption"]


def closing_clause(text):
    """The last comma-delimited clause of the last sentence: where kickers live."""
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s.strip()]
    if not sentences:
        return ""
    last = sentences[-1].rstrip(".")
    parts = [p.strip() for p in last.split(",") if p.strip()]
    return parts[-1] if len(parts) > 1 else ""


def main() -> int:
    frags = {p.stem: json.loads(p.read_text(encoding="ascii")) for p in sorted(FRAG_DIR.glob("*.json"))}
    fatal = 0

    print("=" * 78)
    print("MARKER HITS -- each needs the delete-it-and-see test")
    print("=" * 78)
    hits = 0
    for nid, frag in frags.items():
        for field, text in paragraphs(frag):
            for pattern, label in MARKERS:
                for m in re.finditer(pattern, text, re.IGNORECASE):
                    s, e = max(0, m.start() - 45), min(len(text), m.end() + 45)
                    print(f"  {nid}.{field:12} [{label}]")
                    print(f"      ...{text[s:e].strip()}...")
                    hits += 1
    if not hits:
        print("  none")

    print()
    print("=" * 78)
    print("HOW EVERY PARAGRAPH ENDS -- scan this column for rhythm")
    print("=" * 78)
    for nid, frag in frags.items():
        for field, text in paragraphs(frag):
            tail = closing_clause(text)
            if tail:
                print(f"  {nid}.{field:12} ...{tail}")

    print()
    print("=" * 78)
    print("HARD RULES + SPREAD")
    print("=" * 78)
    for nid, frag in frags.items():
        blob = json.dumps(frag)
        if LONG_DASH.search(blob):
            print(f"  FAIL {nid}: long dash")
            fatal = 1
        if any(ord(c) > 127 for c in blob):
            print(f"  FAIL {nid}: non-ASCII")
            fatal = 1
        if not re.search(r"\bI\b", frag["what"] + " " + frag.get("problem", "")):
            print(f"  FAIL {nid}: no authorship in what/problem")
            fatal = 1

    first = Counter(f["what"].split()[0] for f in frags.values())
    labels = Counter(f.get("problem_label", "The problem") if f.get("problem") else "(omitted)"
                     for f in frags.values())
    print(f"  what first words: {dict(first)}")
    print(f"  second-slot labels: {dict(labels)}")
    print(f"  marker hits needing judgment: {hits}")
    print(f"  systems: {len(frags)}")
    return fatal


if __name__ == "__main__":
    sys.exit(main())
