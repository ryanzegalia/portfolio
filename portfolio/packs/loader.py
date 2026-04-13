"""Pack loader — reads YAML pack definitions into a frozen-by-convention dataclass.

A "pack" is one vertical content bundle (SaaS, Home Care, Vertical AI). Each
pack directory contains 7 YAML files plus an optional `rollups/` folder of
pre-rendered markdown narratives. This module loads, validates cross-references,
and publishes a module-level `PACK_REGISTRY` that the FastAPI app consults on
every request.

Design notes:
- This module MUST NOT import FastAPI. It must be importable from a CLI script
  or a pytest module without pulling in the web framework. Routing lives in
  `packs.routing`.
- Validation is cross-reference only — we catch typos and broken links between
  YAML files at startup so the build crashes loud rather than rendering
  wrong-looking pages later. Prose content (scenario text, rollup markdown,
  how-it-works copy) is owned by the content agents (F, K, M) and deliberately
  NOT validated here.
- The `Pack` dataclass is intended to be treated as immutable after
  construction. We don't set `frozen=True` (it makes the dataclass less
  ergonomic with default factories), but no code should mutate a Pack after
  `load_pack()` returns it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

import config

log = logging.getLogger("portfolio.packs")


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------
class PackLoadError(RuntimeError):
    """Raised when a pack directory is missing required files or has malformed YAML."""


class PackValidationError(RuntimeError):
    """Raised when pack YAML files fail cross-reference validation.

    The message contains the accumulated list of all issues found so content
    authors can fix everything in one pass instead of whack-a-mole.
    """


# ---------------------------------------------------------------------------
# Dataclass
# ---------------------------------------------------------------------------
REQUIRED_YAML_FILES = (
    "pack.yaml",
    "entities.yaml",
    "pipelines.yaml",
    "sources.yaml",
    "connectors.yaml",
    "seed.yaml",
    "scenarios.yaml",
)


@dataclass
class Pack:
    """One vertical content pack, fully loaded into memory.

    Treat as immutable after construction — no field on a Pack should be
    mutated once `load_pack()` has returned it. This is a convention, not
    enforced by `frozen=True`, because the dataclass holds mutable dicts/lists
    and freezing the outer shell doesn't deep-freeze the contents anyway.
    """

    id: str
    name: str
    vertical_label: str
    terminology: dict[str, str]
    nav: list[dict[str, Any]]  # [{label, url}, ...]
    dashboard_cards: list[dict[str, Any]]
    entities: dict[str, dict[str, Any]]  # entity_type -> {fields: [...]}
    pipelines: dict[str, Any]  # raw pipelines.yaml content
    sources: dict[str, dict[str, Any]]  # source_key -> {display_name, source_type}
    connectors: dict[str, dict[str, Any]]  # source_key -> {mappings, reconciliation_rules}
    seed: dict[str, Any]  # raw seed.yaml content
    scenarios: dict[str, Any]  # raw scenarios.yaml content
    rollups: dict[str, str]  # rollup_name -> markdown text (keyed by filename stem)
    pack_dir: Path
    # Scrollytelling landing config (pack.yaml `landing:` block). See
    # templates/vertical_landing.html for consumption. Optional — packs
    # without this block fall back to the legacy operations tile grid.
    #
    # Shape:
    #   {
    #     "hero": {"eyebrow", "problem", "sub_problem"},
    #     "sections": [
    #       {
    #         "id": "phantom_seats",
    #         "loader": "saas.phantom_seats",  # key in SECTION_CONTEXT_LOADERS
    #         "partial": "components/packs/saas/phantom_seats.html",
    #         "narrative": {"eyebrow", "title", "problem", "solution"},
    #         "cta": {"label", "href"},
    #       },
    #       ...
    #     ]
    #   }
    landing: dict[str, Any] = field(default_factory=dict)
    # 2026-04-11 research evidence pass: glossary terms for hover tooltips
    # and research sources for the per-vertical "What I looked at" footer.
    # Both optional; packs without them fall back to no tooltips / no footer.
    glossary: dict[str, str] = field(default_factory=dict)
    research_sources: list[dict[str, Any]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Module-level registry, populated by init_pack_registry()
# ---------------------------------------------------------------------------
PACK_REGISTRY: dict[str, Pack] = {}


# ---------------------------------------------------------------------------
# YAML helpers
# ---------------------------------------------------------------------------
def _read_yaml(path: Path) -> Any:
    """Safe-load a YAML file, wrapping any parser error in PackLoadError."""
    try:
        with path.open("r", encoding="utf-8") as f:
            return yaml.safe_load(f)
    except yaml.YAMLError as exc:
        raise PackLoadError(f"failed to parse {path.name}: {exc}") from exc
    except OSError as exc:
        raise PackLoadError(f"failed to read {path.name}: {exc}") from exc


def _packs_root() -> Path:
    """Resolve the packs root as a Path (config.PACKS_DIR is a str)."""
    return Path(config.PACKS_DIR)


# ---------------------------------------------------------------------------
# Normalization helpers
# ---------------------------------------------------------------------------
def _normalize_entities(raw: Any) -> dict[str, dict[str, Any]]:
    """Accept either a list of `{entity_type, fields}` objects or a dict-form.

    Spec says entities.yaml is a list of `{entity_type, fields: [...]}` items.
    We normalize into `{entity_type: {fields: [...]}}` for fast lookup during
    validation and template rendering.
    """
    if raw is None:
        return {}
    if isinstance(raw, dict):
        # Already in map form: `{entity_type: {fields: [...]}}`
        return {str(k): (v or {}) for k, v in raw.items()}
    if isinstance(raw, list):
        result: dict[str, dict[str, Any]] = {}
        for item in raw:
            if not isinstance(item, dict):
                continue
            etype = item.get("entity_type")
            if not etype:
                continue
            # Preserve all keys (fields, description, etc.) in the value.
            payload = {k: v for k, v in item.items() if k != "entity_type"}
            result[str(etype)] = payload
        return result
    raise PackLoadError(f"entities.yaml: expected list or dict, got {type(raw).__name__}")


def _normalize_sources(raw: Any) -> dict[str, dict[str, Any]]:
    """Accept either a list of source dicts or a `{source_key: {...}}` map."""
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return {str(k): (v or {}) for k, v in raw.items()}
    if isinstance(raw, list):
        result: dict[str, dict[str, Any]] = {}
        for item in raw:
            if not isinstance(item, dict):
                continue
            key = item.get("source_key")
            if not key:
                continue
            payload = {k: v for k, v in item.items() if k != "source_key"}
            result[str(key)] = payload
        return result
    raise PackLoadError(f"sources.yaml: expected list or dict, got {type(raw).__name__}")


def _normalize_connectors(raw: Any) -> dict[str, dict[str, Any]]:
    """Accept either a list of connector dicts or a `{source_key: {...}}` map."""
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return {str(k): (v or {}) for k, v in raw.items()}
    if isinstance(raw, list):
        result: dict[str, dict[str, Any]] = {}
        for item in raw:
            if not isinstance(item, dict):
                continue
            key = item.get("source_key")
            if not key:
                continue
            payload = {k: v for k, v in item.items() if k != "source_key"}
            result[str(key)] = payload
        return result
    raise PackLoadError(f"connectors.yaml: expected list or dict, got {type(raw).__name__}")


def _load_rollups(pack_dir: Path) -> dict[str, str]:
    """Read every `*.md` file from `pack_dir/rollups` into a dict keyed by stem.

    Tolerates a missing or empty rollups/ directory — content agents may not
    have shipped them yet when the loader runs during early build phases.
    """
    rollups_dir = pack_dir / "rollups"
    if not rollups_dir.is_dir():
        log.warning(
            "pack %s: no rollups/ directory — content agents may not have shipped yet",
            pack_dir.name,
        )
        return {}

    result: dict[str, str] = {}
    for md_path in sorted(rollups_dir.glob("*.md")):
        try:
            result[md_path.stem] = md_path.read_text(encoding="utf-8")
        except OSError as exc:
            log.warning("pack %s: failed to read rollup %s: %s", pack_dir.name, md_path.name, exc)
            continue

    if not result:
        log.warning("pack %s: rollups/ is empty", pack_dir.name)

    return result


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
def validate(pack: Pack) -> None:
    """Cross-reference check every foreign-key-style link inside a pack.

    Accumulates all errors and raises a single PackValidationError at the end
    so content authors can see every issue in one pass. Does NOT validate
    free-form prose (scenario card text, rollup markdown, how-it-works copy) —
    those are owned by the content agents and are deliberately out of scope.

    Checks:
      1. Every `source_key` in connectors.yaml must exist in sources.yaml.
      2. Every reconciliation_rules winning source must exist in sources.yaml.
      3. Every pipeline entity_type (if present) must exist in entities.yaml.
      4. Every nav URL is either empty, external, or starts with `/{pack.id}`
         (warning only — nav items may legitimately link to `/architecture`
         or other non-pack-scoped pages).
    """
    errors: list[str] = []

    known_sources = set(pack.sources.keys())
    known_entities = set(pack.entities.keys())

    # --- 1. connectors.yaml source_keys must exist in sources.yaml ---
    for source_key, connector in pack.connectors.items():
        if source_key not in known_sources:
            errors.append(
                f"connectors.yaml: source_key '{source_key}' is not defined in sources.yaml"
            )
        # --- 2. reconciliation_rules winning sources must exist ---
        if not isinstance(connector, dict):
            continue
        rules = connector.get("reconciliation_rules") or {}
        if isinstance(rules, dict):
            for field_name, winning in rules.items():
                # Some packs may use a list of sources for multi-step rules.
                winners = winning if isinstance(winning, list) else [winning]
                for w in winners:
                    if w is None:
                        continue
                    if str(w) not in known_sources:
                        errors.append(
                            f"connectors.yaml: reconciliation_rules for '{source_key}'"
                            f" field '{field_name}' references unknown source '{w}'"
                        )

    # --- 3. pipelines.yaml entity_type references must exist ---
    # pipelines.yaml is free-form, but if a pipeline has an `entity_type` key
    # we check it. Same if the top level is a dict of pipelines and each
    # value has entity_type, or a list of pipeline dicts.
    def _check_pipeline(node: Any, path: str = "pipelines.yaml") -> None:
        if isinstance(node, dict):
            if "entity_type" in node:
                etype = node.get("entity_type")
                if etype and str(etype) not in known_entities:
                    errors.append(
                        f"{path}: references unknown entity_type '{etype}' "
                        f"(not defined in entities.yaml)"
                    )
            for k, v in node.items():
                _check_pipeline(v, f"{path}.{k}")
        elif isinstance(node, list):
            for i, item in enumerate(node):
                _check_pipeline(item, f"{path}[{i}]")

    _check_pipeline(pack.pipelines)

    # --- 4. nav URLs — warn-only, doesn't add to errors list ---
    for item in pack.nav:
        if not isinstance(item, dict):
            continue
        url = item.get("url", "")
        if not url:
            continue
        if url.startswith(("http://", "https://", "mailto:", "#")):
            continue
        if not url.startswith(f"/{pack.id}"):
            log.warning(
                "pack %s: nav URL '%s' (label=%r) does not start with '/%s' "
                "— make sure this is intentional",
                pack.id, url, item.get("label", ""), pack.id,
            )

    if errors:
        joined = "\n  - ".join(errors)
        raise PackValidationError(
            f"pack '{pack.id}' failed validation with {len(errors)} error(s):\n  - {joined}"
        )


# ---------------------------------------------------------------------------
# Core loader
# ---------------------------------------------------------------------------
def load_pack(pack_id: str) -> Pack:
    """Load one pack directory into a Pack dataclass and validate it.

    The `pack_id` argument is the directory name under `packs/`. The canonical
    pack identifier that other modules use (and that becomes the registry key
    and URL segment) is read from `pack.yaml`'s `id` field — that may differ
    from the directory name if content agents want URL-safe hyphens while
    keeping Python-safe underscore directory names.

    Raises:
        PackLoadError: if any required YAML file is missing or malformed.
        PackValidationError: if cross-reference validation fails.
    """
    pack_dir = _packs_root() / pack_id
    if not pack_dir.is_dir():
        raise PackLoadError(f"pack directory not found: {pack_dir}")

    # Check every required file exists before reading anything — we want
    # missing-file errors to list the specific culprit, not bail at whatever
    # the first read happens to be.
    for required in REQUIRED_YAML_FILES:
        candidate = pack_dir / required
        if not candidate.is_file():
            raise PackLoadError(f"missing {required} for pack {pack_id}")

    raw_pack = _read_yaml(pack_dir / "pack.yaml") or {}
    raw_entities = _read_yaml(pack_dir / "entities.yaml")
    raw_pipelines = _read_yaml(pack_dir / "pipelines.yaml") or {}
    raw_sources = _read_yaml(pack_dir / "sources.yaml")
    raw_connectors = _read_yaml(pack_dir / "connectors.yaml")
    raw_seed = _read_yaml(pack_dir / "seed.yaml") or {}
    raw_scenarios = _read_yaml(pack_dir / "scenarios.yaml") or {}

    if not isinstance(raw_pack, dict):
        raise PackLoadError(f"pack.yaml for {pack_id}: expected mapping at top level")

    canonical_id = str(raw_pack.get("id") or pack_id)
    name = str(raw_pack.get("name") or canonical_id)
    vertical_label = str(raw_pack.get("vertical_label") or name)
    terminology = raw_pack.get("terminology") or {}
    nav = raw_pack.get("nav") or []
    dashboard_cards = raw_pack.get("dashboard_cards") or []
    landing = raw_pack.get("landing") or {}
    glossary = raw_pack.get("glossary") or {}
    research_sources = raw_pack.get("research_sources") or []

    if glossary and not isinstance(glossary, dict):
        raise PackLoadError(
            f"pack.yaml for {pack_id}: 'glossary' must be a mapping (term -> definition)"
        )
    if research_sources and not isinstance(research_sources, list):
        raise PackLoadError(
            f"pack.yaml for {pack_id}: 'research_sources' must be a list"
        )

    if not isinstance(terminology, dict):
        raise PackLoadError(f"pack.yaml for {pack_id}: 'terminology' must be a mapping")
    if not isinstance(nav, list):
        raise PackLoadError(f"pack.yaml for {pack_id}: 'nav' must be a list")
    if not isinstance(dashboard_cards, list):
        raise PackLoadError(f"pack.yaml for {pack_id}: 'dashboard_cards' must be a list")
    if not isinstance(landing, dict):
        raise PackLoadError(f"pack.yaml for {pack_id}: 'landing' must be a mapping (or absent)")
    if landing:
        if not isinstance(landing.get("hero") or {}, dict):
            raise PackLoadError(f"pack.yaml for {pack_id}: 'landing.hero' must be a mapping")
        sections = landing.get("sections") or []
        if not isinstance(sections, list):
            raise PackLoadError(f"pack.yaml for {pack_id}: 'landing.sections' must be a list")
        for idx, section in enumerate(sections):
            if not isinstance(section, dict):
                raise PackLoadError(
                    f"pack.yaml for {pack_id}: landing.sections[{idx}] must be a mapping"
                )
            for required_key in ("id", "loader", "partial"):
                if required_key not in section:
                    raise PackLoadError(
                        f"pack.yaml for {pack_id}: landing.sections[{idx}] missing '{required_key}'"
                    )

    entities = _normalize_entities(raw_entities)
    sources = _normalize_sources(raw_sources)
    connectors = _normalize_connectors(raw_connectors)
    rollups = _load_rollups(pack_dir)

    pack = Pack(
        id=canonical_id,
        name=name,
        vertical_label=vertical_label,
        terminology={str(k): str(v) for k, v in terminology.items()},
        nav=list(nav),
        dashboard_cards=list(dashboard_cards),
        entities=entities,
        pipelines=raw_pipelines if isinstance(raw_pipelines, dict) else {"_raw": raw_pipelines},
        sources=sources,
        connectors=connectors,
        seed=raw_seed if isinstance(raw_seed, dict) else {"_raw": raw_seed},
        scenarios=raw_scenarios if isinstance(raw_scenarios, dict) else {"_raw": raw_scenarios},
        rollups=rollups,
        pack_dir=pack_dir,
        landing=landing,
        glossary={str(k): str(v) for k, v in (glossary or {}).items()},
        research_sources=list(research_sources or []),
    )

    validate(pack)
    log.info(
        "loaded pack %s from %s (%d entities, %d sources, %d rollups)",
        pack.id, pack.pack_dir.name, len(pack.entities), len(pack.sources), len(pack.rollups),
    )
    return pack


# ---------------------------------------------------------------------------
# Batch loader
# ---------------------------------------------------------------------------
def load_all_packs() -> dict[str, Pack]:
    """Walk packs/ and load every subdirectory that contains a pack.yaml.

    Tolerates the empty-packs case during early build phases (returns an empty
    dict and logs a warning) so FastAPI startup doesn't crash before Agents F,
    K, and M have shipped their content. The build coordinator re-runs the
    integration checkpoint after those agents land.

    The returned dict is keyed by the canonical pack id (pack.yaml's `id`
    field), which may differ from the directory name.
    """
    root = _packs_root()
    if not root.is_dir():
        log.warning("packs root %s does not exist — returning empty registry", root)
        return {}

    registry: dict[str, Pack] = {}
    for subdir in sorted(root.iterdir()):
        if not subdir.is_dir():
            continue
        if not (subdir / "pack.yaml").is_file():
            log.debug("skipping %s: no pack.yaml", subdir.name)
            continue
        try:
            pack = load_pack(subdir.name)
        except (PackLoadError, PackValidationError) as exc:
            # During real startup we want this to fail loud. load_all_packs is
            # the Wave-3-integration path — it should never mask content bugs.
            log.error("failed to load pack %s: %s", subdir.name, exc)
            raise

        if pack.id in registry:
            raise PackLoadError(
                f"duplicate pack id '{pack.id}' "
                f"(second occurrence in directory {subdir.name})"
            )
        registry[pack.id] = pack

    if not registry:
        log.warning(
            "load_all_packs: no packs found under %s — content agents may not "
            "have shipped yet; continuing with empty registry",
            root,
        )

    return registry


# ---------------------------------------------------------------------------
# Registry bootstrap — called from app.py lifespan
# ---------------------------------------------------------------------------
def init_pack_registry() -> dict[str, Pack]:
    """Populate the module-level `PACK_REGISTRY` from disk.

    Call this once from the FastAPI lifespan after `init_db()`. Other modules
    should then import `PACK_REGISTRY` directly:

        from packs import PACK_REGISTRY

    Returns the registry for convenience so callers can log its keys.
    """
    global PACK_REGISTRY
    loaded = load_all_packs()
    # Rebind in place so existing `from packs.loader import PACK_REGISTRY`
    # references stay valid.
    PACK_REGISTRY.clear()
    PACK_REGISTRY.update(loaded)
    log.info("pack registry initialized: %s", sorted(PACK_REGISTRY.keys()) or "(empty)")
    return PACK_REGISTRY


# ---------------------------------------------------------------------------
# Startup cross-reference validation — runs after init_pack_registry() so the
# container fails to start if canonical scenario ids or glossary keys drift
# out of sync with what the route handlers expect.
# ---------------------------------------------------------------------------
def validate_pack_registry() -> None:
    """Cross-check pack YAML against Python-side canonical ids and conventions.

    Called from the FastAPI lifespan right after `init_pack_registry()`. Raises
    PackValidationError if anything is wrong so startup aborts before the
    seeder runs and before the HTTP server binds.

    Two checks:
      1. Every required scenario id (from `routes.pack_demo.REQUIRED_SCENARIO_IDS`)
         must exist in the matching pack's scenarios.yaml. Prevents the
         "typo in scenarios.yaml silently orphans a scenario card" class of
         content regression.
      2. Every glossary key should contain only characters that survive the
         `markup_terms` Jinja filter's escape-then-match pipeline. This is a
         WARNING-only check (not raising) because the filter has a belt fix
         that handles any character — but warning the pack author at load time
         is cheap and prevents a future puzzle.

    The import of REQUIRED_SCENARIO_IDS is inlined to avoid an import-time
    cycle (packs.loader is imported from packs/__init__.py, which is imported
    by app.py before routes/pack_demo.py; calling this function is deferred to
    lifespan so the cycle is only order-of-import).
    """
    from routes.pack_demo import REQUIRED_SCENARIO_IDS  # inline to avoid cycle

    issues: list[str] = []

    # Check 1: required scenario ids exist per pack.
    for pack_id, required in REQUIRED_SCENARIO_IDS.items():
        pack = PACK_REGISTRY.get(pack_id)
        if pack is None:
            issues.append(f"pack '{pack_id}' is required but not registered")
            continue
        scenarios = pack.scenarios
        if isinstance(scenarios, dict):
            scenarios = scenarios.get("scenarios") or scenarios.get("_raw") or []
        scenario_ids = {
            s.get("id") for s in scenarios
            if isinstance(s, dict) and s.get("id")
        }
        missing = sorted(set(required) - scenario_ids)
        if missing:
            issues.append(
                f"pack '{pack_id}' scenarios.yaml missing required ids: {missing}"
            )

    if issues:
        raise PackValidationError(
            "pack registry validation failed:\n  - " + "\n  - ".join(issues)
        )

    # Check 2: glossary keys with non-safe chars — warn only, don't raise.
    # The markup_terms filter's Commit B fix escapes keys before the regex
    # build, so any character works; this warning is for pack authors who
    # hit the edge case and want to know about it.
    import string
    safe_chars = set(string.ascii_letters + string.digits + " -_./&'")
    for pack_id, pack in PACK_REGISTRY.items():
        glossary = getattr(pack, "glossary", None) or {}
        for key in glossary:
            bad = [c for c in key if c not in safe_chars]
            if bad:
                log.warning(
                    "pack %s: glossary key %r contains chars %r outside the "
                    "safe set — markup_terms filter handles it but test the "
                    "rendered output to be sure",
                    pack_id, key, bad,
                )

    log.info("pack registry validation passed")