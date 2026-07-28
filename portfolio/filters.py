"""Custom Jinja filters for portfolio site templates.

Added 2026-04-11 research evidence pass:

- `markup_terms(text, glossary)` — wraps whole-word matches of glossary keys
  inside <span class="term" data-tip="...">...</span>. Used in the vertical
  landing template to make industry acronyms and named tools hover-definable.
  Longest keys match first so "Sandata EVV" wins over "EVV".

- `highlight_code(code, language)` — Pygments-based server-side syntax
  highlighting for inline SQL / Python code artifacts. Returns a Markup object.
"""

from __future__ import annotations

import hashlib
import os
import re

from jinja2 import pass_context
from markupsafe import Markup, escape

try:
    from pygments import highlight as _pygments_highlight
    from pygments.formatters import HtmlFormatter
    from pygments.lexers import get_lexer_by_name
    _PYGMENTS_AVAILABLE = True
except ImportError:  # pragma: no cover — pygments is optional at dev time
    _PYGMENTS_AVAILABLE = False


def _static_version() -> str:
    """Content hash of the stylesheets, computed once at import.

    Appended as ?v= to the CSS links in base.html so a browser that cached
    yesterday's stylesheet fetches the new one the moment the file changes
    (2026-07-27: Ryan's review hit a stale-cache unstyled page on staging).
    """
    h = hashlib.sha256()
    css_dir = os.path.join(os.path.dirname(__file__), "static", "css")
    try:
        for name in sorted(os.listdir(css_dir)):
            if name.endswith(".css"):
                with open(os.path.join(css_dir, name), "rb") as f:
                    h.update(f.read())
    except OSError:  # pragma: no cover -- missing dir in exotic test setups
        return "0"
    return h.hexdigest()[:10]


STATIC_VERSION = _static_version()


def attach_filters(templates) -> None:
    """Register custom Jinja filters onto a Starlette `Jinja2Templates` instance.

    Each route module in `routes/` creates its own Jinja2Templates object, so
    a central registration has to be applied to every one. Import this helper
    and call it immediately after constructing `templates`.
    """
    templates.env.filters["markup_terms"] = markup_terms
    templates.env.filters["highlight_code"] = highlight_code
    templates.env.globals["static_v"] = STATIC_VERSION


@pass_context
def markup_terms(context, text: str | None, glossary: dict[str, str] | None) -> Markup:
    """Wrap glossary terms in <span class="term" data-tip="...">.

    HTML-escapes the input text first, then substitutes whole-word matches
    of glossary keys (longest first) with term spans. Returns Markup so
    Jinja does not re-escape the output.

    Only acts on raw narrative text, not on text that already contains HTML.

    First-occurrence-only scoping
    ------------------------------
    2026-04-11 scan-budget pass: decorated with `@pass_context` so the
    filter receives the Jinja render context and can store a set of
    already-wrapped canonical term keys on it. Within a single template
    render (e.g. one request for /home-care), only the first occurrence
    of a given glossary term gets a tooltip; subsequent occurrences render
    as plain escaped text. This keeps the text from feeling over-tagged
    (previously 23 .term elements on /home-care for 13 unique terms) while
    preserving the full reference in the glossary <details> block in the
    research footer.

    The seen set lives on `context.vars["_markup_terms_seen"]`. Jinja's
    Context is read-only at the top level but `.vars` is the mutable dict
    the template engine uses for local variables, so we piggyback there.

    Edge cases handled:
    - Case-insensitive matching (displays original case; uses canonical tip)
    - Longer keys match before their substrings ("Sandata EVV" > "EVV")
    - Empty/None inputs return empty Markup
    - Missing glossary returns escaped text unchanged
    """
    if text is None or text == "":
        return Markup("")
    if not glossary:
        return Markup(escape(text))

    escaped = str(escape(text))

    if not glossary.keys():
        return Markup(escaped)

    # L-2 fix: the haystack (`escaped`) is HTML-escaped, so the pattern must
    # be built from ESCAPED glossary keys — otherwise a key containing `&`,
    # `<`, `>`, `'`, `"` (e.g. "R&D") would never match because the haystack
    # has `R&amp;D`. Build (original, escaped) pairs, sort by escaped-length
    # so the longest-first rule still applies, and keep a map back to the
    # original key for the canonical glossary lookup.
    key_pairs = sorted(
        ((k, str(escape(k))) for k in glossary.keys()),
        key=lambda pair: len(pair[1]),
        reverse=True,
    )

    pattern = re.compile(
        r"\b(" + "|".join(re.escape(escaped_k) for _, escaped_k in key_pairs) + r")\b",
        re.IGNORECASE,
    )

    # Lowercase map from escaped-form to original canonical key
    lc_map = {escaped_k.lower(): original_k for original_k, escaped_k in key_pairs}

    # Page-scoped seen set — the same render-context carries across every
    # call to markup_terms during one template render. First occurrence
    # wraps + adds to set; subsequent occurrences of the same canonical
    # key fall through to plain text.
    seen = context.vars.setdefault("_markup_terms_seen", set())

    def _repl(match: re.Match[str]) -> str:
        matched = match.group(1)  # this is the escaped form from the haystack
        canonical = lc_map.get(matched.lower())
        if canonical is None:
            return matched
        if canonical in seen:
            return matched
        seen.add(canonical)
        tip = glossary[canonical]
        tip_esc = str(escape(tip)).replace('"', "&quot;")
        return f'<span class="term" data-tip="{tip_esc}">{matched}</span>'

    return Markup(pattern.sub(_repl, escaped))


def highlight_code(code: str | None, language: str = "text") -> Markup:
    """Render `code` as Pygments-highlighted HTML (server-side, no client JS).

    Falls back to a plain <pre><code> block if Pygments is not installed.
    Returns Markup, so callers can drop the result straight into a template
    without `| safe`.
    """
    if not code:
        return Markup("")

    if _PYGMENTS_AVAILABLE:
        try:
            lexer = get_lexer_by_name(language, stripall=False)
        except Exception:
            lexer = get_lexer_by_name("text")
        formatter = HtmlFormatter(
            nowrap=False,
            cssclass="highlight",
            linenos=False,
        )
        rendered = _pygments_highlight(code, lexer, formatter)
        return Markup(rendered)

    # Fallback: plain pre block
    escaped = escape(code)
    return Markup(f'<pre class="highlight"><code>{escaped}</code></pre>')
