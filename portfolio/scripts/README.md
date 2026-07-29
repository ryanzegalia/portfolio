# scripts/

Build and check tooling for the site. Two of these are the quality gates the
platform map depends on, and both are meant to be run before anything ships.

| Script | What it does |
|---|---|
| `build_platform_map.py` | Generates `templates/platform_map.html` from `platform_map/fragments/*.json` plus the roster. The template is generated, never hand-edited. Exits 1 on non-ASCII, a banned identifier, Jinja delimiters in fragment text, or a roster/fragment mismatch. |
| `check_register.py` | Reads the written copy against the register rules. Exits 1 only on the hard ones; it also prints the closing clause of every paragraph in a single column, which is the view that makes rhythm visible. It cannot judge and does not try. |

## What is deliberately not in this repository

This repo is public. Some of the tooling cannot be published as-is without
handing a reader exactly what the site is built to withhold.

**The identifier list.** `build_platform_map.py` blocks a set of employer,
product and codename strings from ever reaching the page. That list lives in
`scripts/banned_terms.local`, which is gitignored, or in the
`PORTFOLIO_BANNED_TERMS` environment variable. `banned_terms.example` shows the
format. The reasoning is worth stating plainly, because it is easy to get
backwards: **a published list of the words you are avoiding identifies them
exactly as well as using them would.** Same for the test that asserts those
words never render -- it loads them the same way rather than spelling them out.

With no list configured the build prints a loud warning and continues, so a
fresh clone still works; it just tells you the identifier lint is inactive.

**The screenshot harness.** The tool that captures the dashboard screenshots
lives outside this repo and stays there, for two reasons:

1. It is the mapping. To rename identifiers out of a page it has to contain
   every real string and what each becomes -- a complete key to every
   euphemism on the site, in one file, alongside the hostname it points at.
2. One screenshot on the map is generated rather than photographed, because
   the underlying screen had no activity in the window it covers. Publishing
   the generator would disclose which one, and that was a deliberate call
   about how the page presents itself.

The images it produces are committed under `static/img/systems/`. Every one is
audited at full resolution before it ships, because the automated gate reads
the DOM and cannot see text baked into an image, a canvas, an SVG or a logo --
every real defect this page has produced was found in pixels and none of them
in code.
