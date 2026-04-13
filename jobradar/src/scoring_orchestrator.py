"""
JobRadar Scoring Orchestrator.

Two-pronged approach:
1. Fast script-based filtering (title screen + keyword analysis + fit filter)
   -> kills obvious non-matches instantly, no LLM needed
2. LLM gatekeeper (Ollama qwen3:8b) as the AUTHORITY on surviving jobs
   -> reads the JD with full context, makes the real scoring decision

When Ollama is unavailable (workstation off), keyword score is the fallback.
"""

import asyncio
import json
import logging

from scoring.keyword_scorer import analyze_jd, title_screen
from scoring.fit_filter import quick_fit_check
from scoring.ollama_scorer import score_with_ollama

logger = logging.getLogger(__name__)


async def score_job(job) -> dict:
    """
    Run full scoring pipeline on a job.

    Flow:
    1. Title screen (instant) -- reject engineering/sales/design titles
    2. Keyword analysis (fast) -- extract role_type, red_flags, keywords as metadata
    3. Fit filter (fast) -- 6-check go/no-go
    4. Fast rejection -- title fail OR 2+ fit blockers -> archive, skip Ollama
    5. Ollama gatekeeper (smart) -- the authority on surviving jobs
    6. Final score = Ollama score (or keyword fallback if Ollama unavailable)
    """
    jd_text = job.description_text or ""
    title = job.title or ""

    if not jd_text or len(jd_text.strip()) < 50:
        return {
            "keyword_score": 0,
            "ollama_score": None,
            "final_score": 0,
            "fit_decision": "no-go",
            "role_type": "unknown",
            "analysis_json": json.dumps({"error": "No description text"}),
        }

    # -- Phase 1: Title screen (instant) --
    screen = title_screen(title)

    if not screen["pass"]:
        return {
            "keyword_score": 0,
            "ollama_score": None,
            "final_score": 0,
            "fit_decision": "no-go",
            "role_type": "rejected_title",
            "analysis_json": json.dumps({
                "title_screen": screen,
                "fast_rejected": True,
            }),
        }

    # -- Phase 2: Keyword analysis (metadata, not authoritative) --
    jd_analysis = await asyncio.to_thread(analyze_jd, jd_text)
    keyword_score = jd_analysis.get("match_score", 0)
    role_type = jd_analysis.get("role_type", "unknown")

    # -- Phase 3: Fit filter --
    fit_result = await asyncio.to_thread(quick_fit_check, jd_text, jd_analysis)
    fit_decision = fit_result.get("decision", "maybe")
    block_count = fit_result.get("block_count", 0)

    # -- Phase 3.5: Keyword score gate --
    # If keyword_score < 30, the JD has almost no terminology overlap with
    # the candidate profile. Don't waste Ollama time -- use keyword_score as final.
    if keyword_score < 30:
        return {
            "keyword_score": keyword_score,
            "ollama_score": None,
            "final_score": keyword_score,
            "fit_decision": "no-go",
            "role_type": role_type,
            "analysis_json": json.dumps({
                "title_screen": screen,
                "keyword": _keyword_metadata(jd_analysis),
                "fit": _fit_metadata(fit_result),
                "fast_rejected": True,
                "fast_reject_reason": f"keyword_score {keyword_score} below 30 threshold",
            }),
        }

    # -- Phase 4: Fast rejection (fit filter blockers) --
    if block_count >= 2:
        return {
            "keyword_score": keyword_score,
            "ollama_score": None,
            "final_score": 0,
            "fit_decision": "no-go",
            "role_type": role_type,
            "analysis_json": json.dumps({
                "title_screen": screen,
                "keyword": _keyword_metadata(jd_analysis),
                "fit": _fit_metadata(fit_result),
                "fast_rejected": True,
                "fast_reject_reason": f"{block_count} blocking issues in fit filter",
            }),
        }

    # -- Phase 5: Ollama gatekeeper (the authority) --
    ollama_score = None
    ollama_rationale = None
    ollama_decision = None

    ollama_result = await score_with_ollama(jd_text)
    if ollama_result:
        ollama_score = ollama_result["score"]
        ollama_rationale = ollama_result.get("rationale", "")
        ollama_decision = ollama_result.get("decision")

    # -- Phase 6: Final score logic --
    if ollama_score is not None:
        # Ollama is the authority
        final_score = ollama_score
        if ollama_decision:
            fit_decision = ollama_decision
        elif ollama_score >= 60:
            fit_decision = "go"
        elif ollama_score >= 40:
            fit_decision = "maybe"
        else:
            fit_decision = "no-go"
    else:
        # Ollama unavailable -- keyword fallback
        final_score = keyword_score

    # Build analysis JSON
    analysis = {
        "title_screen": screen,
        "keyword": _keyword_metadata(jd_analysis),
        "fit": _fit_metadata(fit_result),
    }

    if ollama_score is not None:
        analysis["ollama"] = {
            "score": ollama_score,
            "rationale": ollama_rationale,
            "decision": ollama_decision,
            "is_authority": True,
        }
    else:
        analysis["ollama_pending"] = True

    return {
        "keyword_score": keyword_score,
        "ollama_score": ollama_score,
        "final_score": final_score,
        "fit_decision": fit_decision,
        "role_type": role_type,
        "analysis_json": json.dumps(analysis),
    }


def _keyword_metadata(jd_analysis: dict) -> dict:
    """Extract keyword analysis metadata (for display, not scoring)."""
    return {
        "score": jd_analysis.get("match_score", 0),
        "role_type": jd_analysis.get("role_type", "unknown"),
        "role_type_scores": jd_analysis.get("role_type_scores", {}),
        "top_keywords": jd_analysis.get("top_keywords", []),
        "red_flags": jd_analysis.get("red_flags", []),
        "green_flags": jd_analysis.get("green_flags", []),
        "euphemisms": jd_analysis.get("euphemisms_decoded", []),
        "gaps": jd_analysis.get("gaps", []),
        "total_requirements": jd_analysis.get("total_requirements", 0),
        "strong_matches": jd_analysis.get("strong_matches", 0),
        "moderate_matches": jd_analysis.get("moderate_matches", 0),
        "gap_count": jd_analysis.get("gap_count", 0),
    }


def _fit_metadata(fit_result: dict) -> dict:
    """Extract fit filter metadata."""
    return {
        "decision": fit_result.get("decision", "maybe"),
        "rationale": fit_result.get("rationale", ""),
        "checks": fit_result.get("checks", []),
        "block_count": fit_result.get("block_count", 0),
        "go_count": fit_result.get("go_count", 0),
    }
