"""Application generation routes -- triggers pipeline, stores results, proxies PDFs."""

import asyncio
import json
import logging
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from config import APPGEN_URL
from db import get_db, Job, Application, SessionLocal

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")

_generating = set()  # Track in-progress job IDs


def _store_pipeline_result(app_rec, result: dict, db_session) -> bool:
    """Store pipeline result into an Application record. Returns True on success.
    Shared between the normal generation path and crash recovery."""
    resume_data = result.get("resume", {})
    cover_letter_data = result.get("cover_letter", {})

    has_resume = bool(resume_data.get("markdown") or resume_data.get("sections"))
    has_cover = bool(cover_letter_data.get("paragraphs") or cover_letter_data.get("greeting"))

    if not (has_resume or has_cover):
        return False

    app_rec.resume_json = json.dumps(resume_data)
    app_rec.cover_letter_json = json.dumps(cover_letter_data)

    interview_prep = result.get("interview_prep", {})
    bullet_defense = result.get("bullet_defense", {})
    if bullet_defense:
        interview_prep["bullet_defense"] = bullet_defense
    app_rec.interview_prep_json = json.dumps(interview_prep)

    company_research = result.get("company_research", {})
    if company_research:
        app_rec.company_research_json = json.dumps(company_research)

    app_rec.validation_json = json.dumps(result.get("validation", {}))
    pipeline_data = result.get("pipeline", {})
    pipeline_data["mode"] = result.get("mode", "agent")
    app_rec.pipeline_json = json.dumps(pipeline_data)
    app_rec.status = "draft"
    app_rec.generated_at = datetime.now(timezone.utc)
    db_session.commit()
    return True


# -- Trigger Generation --

@router.post("/jobs/{job_id}/generate")
async def generate_application(job_id: str, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Trigger resume + cover letter generation for a job."""
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job_id in _generating:
        return {"status": "already_generating"}

    # Auto-recover stuck "generating" applications from interrupted deploys
    stuck = (
        db.query(Application)
        .filter(Application.job_id == job_id, Application.status == "generating")
        .first()
    )
    if stuck and stuck.generated_at is None:
        age = (datetime.now(timezone.utc) - stuck.created_at).total_seconds()
        if age > 1200:  # 20 minutes
            stuck.status = "error"
            stuck.pipeline_json = json.dumps({"error": "Previous generation timed out (likely interrupted by deploy)"})
            db.commit()
            logger.info(f"Auto-recovered stuck application {stuck.id} for {job.company}")

    # Create application record
    app_record = Application(
        job_id=job_id,
        status="generating",
    )
    db.add(app_record)
    db.commit()
    db.refresh(app_record)

    app_id = app_record.id

    async def _do_generate():
        _generating.add(job_id)
        gen_db = SessionLocal()
        try:
            app_rec = gen_db.query(Application).filter(Application.id == app_id).first()
            job_rec = gen_db.query(Job).filter(Job.id == job_id).first()

            if not app_rec or not job_rec:
                return

            # Check for existing research to reuse
            existing_research = (
                gen_db.query(Application)
                .filter(
                    Application.job_id == job_id,
                    Application.company_research_json.isnot(None),
                    Application.id != app_id,
                )
                .first()
            )
            if existing_research:
                app_rec.company_research_json = existing_research.company_research_json
                gen_db.commit()
                logger.info(f"Reused existing research for {job_rec.company}")

            async with httpx.AsyncClient(timeout=30) as client:
                # Step 1: Kick off generation (returns immediately)
                generate_payload = {
                    "jd_text": job_rec.description_text or "",
                    "company": job_rec.company,
                    "job_title": job_rec.title,
                    "role_type": job_rec.role_type,
                }
                resp = await client.post(
                    f"{APPGEN_URL}/generate",
                    json=generate_payload,
                )
                resp.raise_for_status()
                logger.info(f"Pipeline started for {job_rec.company}")

                # Step 2: Poll /status until done (no timeout -- agent takes as long as it needs)
                while True:
                    await asyncio.sleep(2)
                    status_resp = await client.get(f"{APPGEN_URL}/status")
                    status_data = status_resp.json()

                    if not status_data.get("running"):
                        break

                # Step 3: Get result
                result_resp = await client.get(f"{APPGEN_URL}/result")
                if result_resp.status_code == 200:
                    result = result_resp.json()

                    if _store_pipeline_result(app_rec, result, gen_db):
                        logger.info(f"Application generated for {job_rec.company} -- {job_rec.title}")
                    else:
                        app_rec.status = "error"
                        app_rec.pipeline_json = json.dumps({
                            "error": "Pipeline completed but returned empty content",
                            "raw_result_keys": list(result.keys()),
                        })
                        gen_db.commit()
                        logger.warning(f"Empty result from pipeline for {job_rec.company}")
                else:
                    app_rec.status = "error"
                    app_rec.pipeline_json = json.dumps({"error": f"Pipeline returned status {result_resp.status_code}"})
                    gen_db.commit()

        except (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError, httpx.ReadTimeout) as e:
            error_msg = f"AppGen connection failed ({type(e).__name__})"
            logger.error(error_msg)
            if app_rec := gen_db.query(Application).filter(Application.id == app_id).first():
                app_rec.status = "error"
                # Include company_slug so recovery endpoint can find output files
                company_slug = ""
                try:
                    jr = gen_db.query(Job).filter(Job.id == job_id).first()
                    if jr:
                        company_slug = jr.company.lower().replace(" ", "-").replace(".", "")
                except Exception:
                    pass
                app_rec.pipeline_json = json.dumps({
                    "error": error_msg,
                    "recoverable": True,
                    "company_slug": company_slug,
                })
                gen_db.commit()
        except Exception as e:
            error_msg = f"{type(e).__name__}: {e}" if str(e) else f"{type(e).__name__} (no message)"
            logger.error(f"Generation failed: {error_msg}", exc_info=True)
            if app_rec := gen_db.query(Application).filter(Application.id == app_id).first():
                app_rec.status = "error"
                app_rec.pipeline_json = json.dumps({"error": error_msg})
                gen_db.commit()
        finally:
            gen_db.close()
            _generating.discard(job_id)

    background_tasks.add_task(_do_generate)
    return {"status": "generating", "application_id": app_id}


# -- Pipeline Progress (proxy to appgen /status) --

@router.get("/generate-status")
async def get_generate_status():
    """Proxy to appgen /status for real-time pipeline progress."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{APPGEN_URL}/status")
            return resp.json()
    except Exception:
        return {"running": False, "phase": "Unavailable", "phase_num": 0, "phase_total": 12}


# -- Get Application --

@router.get("/jobs/{job_id}/application")
def get_application(job_id: str, db: Session = Depends(get_db)):
    """Get the latest application for a job."""
    app_rec = (
        db.query(Application)
        .filter(Application.job_id == job_id)
        .order_by(Application.created_at.desc())
        .first()
    )

    if not app_rec:
        return {"status": "none"}

    # Auto-recover stuck "generating" applications (deploy interruptions)
    if app_rec.status == "generating" and app_rec.generated_at is None:
        age = (datetime.now(timezone.utc) - app_rec.created_at).total_seconds()
        if age > 1200:  # 20 minutes
            app_rec.status = "error"
            app_rec.pipeline_json = json.dumps({"error": "Generation timed out (likely interrupted by deploy)"})
            db.commit()
            logger.info(f"Auto-recovered stuck application {app_rec.id} on page load")

    # Auto-recover from AppGen crash: try to retrieve output files
    if app_rec.status == "error" and job_id not in _generating:
        pipeline = json.loads(app_rec.pipeline_json or "{}")
        if pipeline.get("recoverable"):
            company_slug = pipeline.get("company_slug", "")
            if company_slug:
                try:
                    resp = httpx.get(f"{APPGEN_URL}/recover/{company_slug}", timeout=10)
                    if resp.status_code == 200:
                        recovered = resp.json()
                        if _store_pipeline_result(app_rec, recovered, db):
                            logger.info(f"Auto-recovered application for {company_slug} from AppGen output files")
                except Exception as recover_err:
                    logger.debug(f"Recovery attempt failed for {company_slug}: {recover_err}")

    result = {
        "id": app_rec.id,
        "status": app_rec.status,
        "version": app_rec.version,
        "generated_at": app_rec.generated_at.isoformat() if app_rec.generated_at else None,
        "edited_at": app_rec.edited_at.isoformat() if app_rec.edited_at else None,
        "exported_at": app_rec.exported_at.isoformat() if app_rec.exported_at else None,
    }

    if app_rec.status in ("draft", "editing", "exported"):
        result["resume"] = json.loads(app_rec.resume_edited_json or app_rec.resume_json or "{}")
        result["cover_letter"] = json.loads(app_rec.cover_letter_edited_json or app_rec.cover_letter_json or "{}")
        result["interview_prep"] = json.loads(app_rec.interview_prep_json or "{}")
        result["company_research"] = json.loads(app_rec.company_research_json or "{}")
        result["validation"] = json.loads(app_rec.validation_json or "{}")
        result["pipeline"] = json.loads(app_rec.pipeline_json or "{}")

    # Include company research even for non-draft statuses (standalone research)
    if app_rec.status not in ("draft", "editing", "exported") and app_rec.company_research_json:
        result["company_research"] = json.loads(app_rec.company_research_json)

    if app_rec.status == "error":
        result["error"] = json.loads(app_rec.pipeline_json or "{}").get("error", "Unknown error")

    return result


# -- Standalone Company Research --

_researching = set()  # Track in-progress research job IDs


@router.post("/jobs/{job_id}/research")
async def research_company(job_id: str, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Trigger standalone company research (no full application generation)."""
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job_id in _researching:
        return {"status": "already_researching"}

    # Check if an application exists -- update it, or create a research-only one
    app_rec = (
        db.query(Application)
        .filter(Application.job_id == job_id)
        .order_by(Application.created_at.desc())
        .first()
    )
    if not app_rec:
        app_rec = Application(job_id=job_id, status="research_only")
        db.add(app_rec)
        db.commit()
        db.refresh(app_rec)

    app_id = app_rec.id

    async def _do_research():
        _researching.add(job_id)
        gen_db = SessionLocal()
        try:
            app_rec = gen_db.query(Application).filter(Application.id == app_id).first()
            job_rec = gen_db.query(Job).filter(Job.id == job_id).first()
            if not app_rec or not job_rec:
                return

            async with httpx.AsyncClient(timeout=30) as client:
                # Kick off research
                resp = await client.post(
                    f"{APPGEN_URL}/research",
                    json={
                        "company": job_rec.company,
                        "job_title": job_rec.title,
                        "jd_text": job_rec.description_text or "",
                    },
                )
                resp.raise_for_status()

                # Poll research status
                while True:
                    await asyncio.sleep(2)
                    status_resp = await client.get(f"{APPGEN_URL}/research-status")
                    status_data = status_resp.json()
                    if not status_data.get("running"):
                        break

                # Get result
                result_resp = await client.get(f"{APPGEN_URL}/research-result")
                if result_resp.status_code == 200:
                    research_data = result_resp.json()
                    if research_data and research_data.get("parsed"):
                        app_rec.company_research_json = json.dumps(research_data)
                        gen_db.commit()
                        logger.info(f"Company research completed for {job_rec.company}")
                    else:
                        logger.warning(f"Research returned empty for {job_rec.company}")
                else:
                    logger.warning(f"Research result status {result_resp.status_code}")

        except (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError, httpx.ReadTimeout) as e:
            logger.error(f"AppGen connection failed for research ({type(e).__name__})")
        except Exception as e:
            logger.error(f"Research failed: {type(e).__name__}: {e}", exc_info=True)
        finally:
            gen_db.close()
            _researching.discard(job_id)

    background_tasks.add_task(_do_research)
    return {"status": "researching", "application_id": app_id}


@router.get("/research-status")
async def get_research_status():
    """Proxy to appgen /research-status for research progress."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{APPGEN_URL}/research-status")
            return resp.json()
    except Exception:
        return {"running": False, "phase": "Unavailable"}


# -- Update Application (editing) --

class ApplicationUpdate(BaseModel):
    resume: dict | None = None
    cover_letter: dict | None = None

@router.patch("/applications/{app_id}")
def update_application(app_id: str, update: ApplicationUpdate, db: Session = Depends(get_db)):
    """Save edits to resume or cover letter."""
    app_rec = db.query(Application).filter(Application.id == app_id).first()
    if not app_rec:
        raise HTTPException(status_code=404, detail="Application not found")

    if update.resume is not None:
        app_rec.resume_edited_json = json.dumps(update.resume)
    if update.cover_letter is not None:
        app_rec.cover_letter_edited_json = json.dumps(update.cover_letter)

    app_rec.status = "editing"
    app_rec.edited_at = datetime.now(timezone.utc)
    db.commit()

    return {"ok": True, "status": app_rec.status}


# -- PDF / DOCX Download (proxy to appgen) --

def _extract_render_text(app_rec: Application, doc_type: str) -> str:
    """Extract markdown/text for the requested doc_type, preferring edited over original."""
    if doc_type == "resume":
        edited = json.loads(app_rec.resume_edited_json or "{}")
        original = json.loads(app_rec.resume_json or "{}")
        # Edited shape: {markdown: "..."}  Original shape: {markdown: "...", summary_text: "..."}
        return edited.get("markdown") or original.get("markdown") or ""
    else:
        edited = json.loads(app_rec.cover_letter_edited_json or "{}")
        original = json.loads(app_rec.cover_letter_json or "{}")
        # Edited shape: {text: "..."}  Original shape: {greeting, paragraphs, full_text, word_count}
        return edited.get("text") or original.get("full_text") or ""


async def _render_document(
    job_id: str, doc_type: str, fmt: str, db: Session,
) -> tuple[bytes, str]:
    """Fetch app record, extract text, POST to AppGen, return (content, filename)."""
    if doc_type not in ("resume", "cover_letter"):
        raise HTTPException(status_code=400, detail="Type must be 'resume' or 'cover_letter'")
    if fmt not in ("pdf", "docx"):
        raise HTTPException(status_code=400, detail="Format must be 'pdf' or 'docx'")

    app_rec = (
        db.query(Application)
        .filter(Application.job_id == job_id)
        .order_by(Application.created_at.desc())
        .first()
    )
    if not app_rec or app_rec.status == "generating":
        raise HTTPException(status_code=404, detail="No completed application found")

    text = _extract_render_text(app_rec, doc_type)
    if not text.strip():
        raise HTTPException(status_code=400, detail=f"No {doc_type} content available to render")

    job = db.query(Job).filter(Job.id == job_id).first()
    company = (job.company if job else "unknown")

    try:
        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(
                f"{APPGEN_URL}/render-{fmt}",
                json={"type": doc_type, "text": text, "company": company},
            )
            resp.raise_for_status()
            company_slug = company.replace(" ", "_")
            # Filename pattern: Candidate_DocType_Company.ext
            # Configure CANDIDATE_NAME in config.py for your own name
            filename = f"{doc_type.replace('_', ' ').title()}_{company_slug}.{fmt}"
            return resp.content, filename
    except (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError, httpx.ReadTimeout) as e:
        raise HTTPException(status_code=503, detail=f"AppGen connection failed ({type(e).__name__})")


@router.get("/jobs/{job_id}/application/pdf/{doc_type}")
async def download_pdf(job_id: str, doc_type: str, db: Session = Depends(get_db)):
    """Download resume or cover letter as PDF. Proxies to appgen service."""
    content, filename = await _render_document(job_id, doc_type, "pdf", db)
    return StreamingResponse(
        iter([content]),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/jobs/{job_id}/application/docx/{doc_type}")
async def download_docx(job_id: str, doc_type: str, db: Session = Depends(get_db)):
    """Download resume or cover letter as DOCX."""
    content, filename = await _render_document(job_id, doc_type, "docx", db)
    return StreamingResponse(
        iter([content]),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
