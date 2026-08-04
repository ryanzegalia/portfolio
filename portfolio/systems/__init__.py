"""Per-system landing pages for the personal production environment.

Shaped like `packs.PACK_REGISTRY` so the two read the same way, but with none
of the machinery behind it. The industry packs run a loader per section
against seeded Postgres; these have no database. Their right-hand column is a
screenshot or a hand-drawn SVG, so the whole registry is static content and
`routes/systems.py` just looks a slug up and renders.

Why this exists (2026-08-03): the home page briefly carried the full
constraint / how-it-works treatment inline on each tile and buried everything
under it. The prose moved here, onto the same scrollytelling layout the
industry explorations use, and the home page went back to being an index.

Section shape:

    {
      "id":       str,
      "eyebrow":  str,
      "title":    str,
      "problem":  str  -- paragraphs split on a blank line
      "solution": str  -- same
      "figure":   None | {"kind": "shot",    "src", "thumb", "alt", "caption"}
                       | {"kind": "diagram", "partial", "ctx", "caption"}
    }

Copy rules, same as the home page: no em dashes, no sentence whose only job
is to interpret the sentence before it, and every number a floor claim that
stays true as the counts grow.
"""

_SHOT = "/static/img/personal/"


JOB_PIPELINE = {
    "slug": "job-pipeline",
    "github": "https://github.com/ryanzegalia/portfolio/tree/main/jobradar",
    "name": "A scoring pipeline over more than 108,000 job postings",
    "eyebrow": "Data pipeline",
    "pack": "radar",
    "hero": {
        "problem": "Six job boards between them post more than I can read, "
                   "and most of what they post isn't close.",
        "standfirst": "Six scrapers pull postings into one archive, and a "
                      "scoring pass ranks each one against the work "
                      "I actually do.",
    },
    "sections": [
        {
            "id": "archive",
            "eyebrow": "The archive",
            "title": "Six sources, one place to look",
            "problem": (
                "Job boards don't agree on anything. Each one names its fields "
                "differently, paginates differently, and decides on its own when a "
                "posting is stale. Reading six of them means reading the same "
                "posting three times and missing the one that only went up on the "
                "board I skipped."
            ),
            "solution": (
                "Six scrapers land everything in one Postgres archive with the "
                "full description kept intact, so a posting is searchable by any "
                "word in it rather than by whatever the board chose to tag it "
                "with. Company watchlists come off Ashby, Greenhouse and Lever "
                "directly, and the aggregators fill in what the watchlists miss.\n\n"
                "Keeping the whole description matters because the scoring pass "
                "downstream reads position and repetition inside the "
                "text, and a truncated posting scores wrong."
            ),
            "figure": {
                "kind": "shot",
                "src": _SHOT + "job-radar.png?v=2",
                "thumb": _SHOT + "thumb-job-radar.jpg?v=2",
                "alt": "Job search tool: full-text results for ERP integration "
                       "ranked by fit score",
                "caption": "Full-text search over the archive. Every posting "
                           "carries its fit score, best first.",
            },
        },
        {
            "id": "funnel",
            "eyebrow": "The scoring pass",
            "title": "Reject fast, score slow",
            "problem": (
                "Scoring a posting properly means having a model read the whole "
                "description and judge it against what I can actually do. Running "
                "a 27B model over everything that lands costs more time and "
                "electricity than the search is worth, and the great majority of "
                "postings are decided long before judgment is needed."
            ),
            "solution": (
                "So the cheap checks run first and the model runs last. A title "
                "screen throws out the obvious misses on 40-odd patterns in "
                "microseconds. A keyword pass parses the description into "
                "sections and weights terms by where they appear and how often, "
                "with a small dictionary that disambiguates words like "
                "\"automation\" that mean different things depending on the "
                "industry.\n\n"
                "Six independent checks then vote on fit: remote, salary floor, "
                "role type, experience, red flags, and company stage. Two "
                "blockers is a rejection. Anything still alive with a keyword "
                "score under 30 is dropped before the model ever sees it, which "
                "is where most of the savings come from."
            ),
            "figure": {
                "kind": "component",
                "partial": "components/systems/pipeline.html",
                "caption": "Counts are pulled from the archive. Only the gates the "
                           "schema can actually account for carry one.",
                "ctx": {
                    "stat": {
                        "label": "Postings scored",
                        "value": "108,380",
                        "caption": "Six scrapers into one archive, scored on arrival",
                        "pill": "scoring continuously",
                    },
                    "title": "Every posting runs this ladder",
                    "subtitle": "Cheapest check first, the model last",
                    "verdict": {"label": "reach the model", "value": "44%"},
                    "gates": [
                        {"name": "Title screen", "grouped": True,
                         "checks": "40+ reject patterns, runs in microseconds"},
                        {"name": "Keyword analysis", "grouped": True,
                         "checks": "sections parsed, terms weighted by position and repetition"},
                        {"name": "Fit filter", "grouped": True,
                         "checks": "six checks vote, two blockers is a rejection"},
                        {"name": "Keyword gate", "grouped": True,
                         "checks": "under 30 is dropped before the model sees it",
                         "note": "60,241 stop here"},
                        {"name": "Local model", "checks": "reads the whole description and makes the call",
                         "note": "48,139 read"},
                        {"name": "Reconcile", "checks": "the model's score outranks the keyword score",
                         "note": "426 go or maybe"},
                        {"name": "Alert", "checks": "70 or better shows up in Discord",
                         "note": "239 alerted"},
                    ],
                    "bracket": "The four cheap gates share one total. The archive records "
                               "them under a single decision, so splitting that into "
                               "per-gate numbers would mean inventing them.",
                    "footer": {"fill_pct": 44, "pill": "44% ever cost a model call"},
                },
            },
            "code_artifact": {
                "caption": "The scoring pipeline, phase by phase",
                "language": "python",
                "source": "Excerpt from scoring_orchestrator.py. The payload each "
                          "early return builds is elided behind **payload; the "
                          "control flow is verbatim. Every early return carries "
                          "ollama_score=None, which is what it looks like for a "
                          "posting to cost nothing.",
                "code": '''async def score_job(job) -> dict:
    jd_text = job.description_text or ""
    title = job.title or ""

    # -- Phase 1: Title screen (instant) --
    screen = title_screen(title)
    if not screen["pass"]:
        return {**payload, "ollama_score": None, "fit_decision": "no-go",
                "role_type": "rejected_title"}

    # -- Phase 2: Keyword analysis (metadata, not authoritative) --
    jd_analysis = await asyncio.to_thread(analyze_jd, jd_text)
    keyword_score = jd_analysis.get("match_score", 0)

    # -- Phase 3: Fit filter --
    fit_result = await asyncio.to_thread(quick_fit_check, jd_text, jd_analysis)
    block_count = fit_result.get("block_count", 0)

    # -- Phase 3.5: Keyword score gate --
    # If keyword_score < 30, the JD has almost no terminology overlap with
    # the candidate profile. Don't waste Ollama time.
    if keyword_score < 30:
        return {**payload, "ollama_score": None, "final_score": keyword_score,
                "fast_reject_reason": f"keyword_score {keyword_score} below 30 threshold"}

    # -- Phase 4: Fast rejection (fit filter blockers) --
    if block_count >= 2:
        return {**payload, "ollama_score": None, "final_score": 0,
                "fast_reject_reason": f"{block_count} blocking issues"}

    # -- Phase 5: Ollama gatekeeper (the authority) --
    ollama_score = None
    ollama_result = await score_with_ollama(jd_text)
    if ollama_result:
        ollama_score = ollama_result["score"]

    # -- Phase 6: Final score logic --
    if ollama_score is not None:
        final_score = ollama_score          # Ollama is the authority
    else:
        final_score = keyword_score         # keyword fallback if it is down''',
            },
        },
        {
            "id": "authority",
            "eyebrow": "The judgment call",
            "title": "The keyword score opens the door, the model decides",
            "problem": (
                "A keyword score is a proxy. It rewards a posting for using the "
                "vocabulary I use, which catches the obvious matches and also "
                "catches every posting written by someone who likes the same "
                "words. It can't tell the difference between a role that needs "
                "the work I do and a role that merely describes it."
            ),
            "solution": (
                "What clears the gate goes to a local model that reads the "
                "description and makes the final call, and its answer outranks "
                "the keyword score rather than averaging with it. A reconciliation "
                "pass writes one number back to the posting so the archive stays "
                "sortable, and anything scoring 70 or better shows up in Discord "
                "while I'm doing something else.\n\n"
                "From there a second machine takes over. It pulls company "
                "research and the job description apart, picks the evidence that "
                "matches, and drafts the resume and cover letter against a "
                "database of things I have actually done."
            ),
            "figure": None,
        },
    ],
    "status": (
        "Running since April 2026, and the archive holds more than 108,000 "
        "postings. More than 60,000 of them were rejected by the cheap checks "
        "and never cost a model call. 239 so far have scored 70 or better."
    ),
    "signals": "FastAPI &middot; PostgreSQL &middot; local 27B model &middot; two machines",
}


GPU = {
    "slug": "gpu",
    "github": "https://github.com/ryanzegalia/portfolio/tree/main/ai-infra",
    "name": "A scheduler and cost ledger for one shared GPU",
    "eyebrow": "Self-hosted AI",
    "pack": "ai-stack",
    "hero": {
        "problem": "Every AI job in the house runs on one card, and a lot of "
                   "them want it at the same time.",
        "standfirst": "So I built the thing that decides who gets it, the lease "
                      "that hands the whole card to one job at a time, and the "
                      "ledger that rebuilds what each program spent.",
    },
    "sections": [
        {
            "id": "contention",
            "eyebrow": "The contention",
            "title": "One card, four things that all want it",
            "problem": (
                "All of the AI in my home lab runs through the one GPU on my "
                "workstation. The model that summarizes my sessions wants it, so "
                "does image generation, so does the agent that watches the "
                "machines, and so does whatever I am actually working on. Two of "
                "them on the card at the same time means both are slow and one "
                "usually falls over."
            ),
            "solution": (
                "A proxy sits in front of the GPU and dispatches by priority, so "
                "a background job yields to something I am waiting on rather than "
                "racing it. Every caller is registered with a priority I can "
                "change at runtime, and a caller that is misbehaving can be "
                "paused without stopping anything else."
            ),
            "figure": {
                "kind": "shot",
                "src": _SHOT + "scheduler.png",
                "thumb": _SHOT + "thumb-scheduler.jpg",
                "alt": "GPU scheduler dashboard: program priority table, model "
                       "health, live dispatches, recent activity",
                "caption": "The scheduler, live. It shows which program has "
                           "priority, what's on the GPU right now, and how long "
                           "each one waited.",
            },
        },
        {
            "id": "lease",
            "eyebrow": "The lease",
            "title": "Handing the whole card to one job without losing it",
            "problem": (
                "Priority dispatch works while everyone is sharing. Some jobs "
                "can't share. A model that needs the full card has to have the "
                "others off it first, and the naive version of that is a lock, "
                "which is fine right up until the thing holding it dies. Then the "
                "card is gone and nothing else can have it."
            ),
            "solution": (
                "So the lease carries a time limit. A caller acquires it, the "
                "proxy drains the running models off the card and parks the other "
                "callers, and the lease holder gets the card to itself. It can "
                "renew while it is still working, and if it stops renewing the "
                "lease expires on its own and the proxy brings everything back "
                "up. A session that dies holding the card doesn't keep it.\n\n"
                "The same tool layer that hands out leases also drives the "
                "devices around the house, deploy and logs and restart, so a "
                "session can set up a test on a handheld and run it without me "
                "in the middle."
            ),
            "figure": {
                "kind": "component",
                "partial": "components/systems/pipeline.html",
                "caption": "The expiry is the whole point, because nothing has "
                           "to notice that the holder died.",
                "ctx": {
                    "stat": {
                        "label": "The hard ceiling on any lease",
                        "value": "3,600 s",
                        "caption": "Renewing restarts the clock. A holder that "
                                   "goes silent loses the card on its own",
                        "pill": "running daily",
                    },
                    "title": "Acquiring the card, and every way out",
                    "subtitle": "Each guard answers before anything is drained",
                    "verdict": {"label": "ways it refuses", "value": "3"},
                    "gates": [
                        {"name": "Acquire",
                         "checks": "drains every model off the card, parks the "
                                   "other callers",
                         "note": "lease granted"},
                        {"name": "Already leased",
                         "checks": "one lease at a time, no queue behind it",
                         "note": "refused, 409"},
                        {"name": "Not in work mode",
                         "checks": "gaming or image generation already owns "
                                   "the card",
                         "note": "refused, 409"},
                        {"name": "Rollout mid-flight",
                         "checks": "a mode change is in progress, don't stomp it",
                         "note": "refused, 409"},
                        {"name": "Renew",
                         "checks": "a heartbeat that replaces the expiry with a "
                                   "fresh one",
                         "note": "clock restarts"},
                        {"name": "Expiry",
                         "checks": "the holder went silent and the clock ran out",
                         "note": "released on its own"},
                        {"name": "Restart",
                         "checks": "models come back up, parked callers resume",
                         "note": "nothing to clean up"},
                    ],
                    "bracket": None,
                    "footer": {"fill_pct": 8,
                               "pill": "default lease 300 s, ceiling 3,600 s"},
                },
            },
            "code_artifact": {
                "caption": "Acquiring the card, and the three ways it refuses",
                "language": "python",
                "source": "Excerpt from gpu_usage_proxy.py. Request parsing and the "
                          "response payloads are elided; the guards, the expiry and "
                          "the locking are verbatim.",
                "code": r'''PROXY_LEASE_MAX_TTL_SEC = int(os.environ.get("PROXY_LEASE_MAX_TTL_SEC", "3600"))

# The lease dict is REPLACED wholesale (never mutated in place) so the hot-path
# read in _gpu_lease_active() is lock-free safe (CPython atomic ref read).
_gpu_lease_lock = threading.Lock()
_gpu_lease: dict | None = None


def _gpu_lease_active() -> dict | None:
    """Return the active lease dict if one is held and not expired, else None."""
    lease = _gpu_lease
    if lease is None:
        return None
    if time.time() * 1000 >= lease["expires_ms"]:
        return None  # expired; the monitor loop finalizes the release (restart vLLM)
    return lease


@app.post("/api/gpu/lease")
async def api_gpu_lease_acquire(request: Request):
    """Acquire an exclusive GPU lease: drain ALL VRAM (stop vLLM, evict Ollama,
    free ComfyUI) and park non-PROTECTED LLM callers on the hold queue until
    release or TTL expiry. Mode stays 'work' -- this is NOT a mode flip.

      ttl_sec : seconds until auto-release, capped at PROXY_LEASE_MAX_TTL_SEC.
                The lease ALWAYS expires.
    """
    global _gpu_lease
    ttl_sec = max(1, min(ttl_sec, PROXY_LEASE_MAX_TTL_SEC))

    # Guard 1: one lease at a time.
    if _gpu_lease_active() is not None:
        return JSONResponse({"error": "already_leased"}, status_code=409)
    # Guard 2: only from work mode (gaming/imagegen already own the card; a lease
    # on top would restart vLLM on release while the mode still says drained).
    if mode != "work":
        return JSONResponse({"error": "mode_not_work"}, status_code=409)
    # Guard 3: don't stomp an in-progress mode rollout.
    if _active_rollout is not None:
        return JSONResponse({"error": "rollout_active"}, status_code=409)

    now_ms = time.time() * 1000
    lease = {"id": f"lease-{int(now_ms)}-{secrets.token_hex(4)}",
             "holder": holder, "reason": reason,
             "acquired_ms": int(now_ms),
             "expires_ms": int(now_ms + ttl_sec * 1000),
             "ttl_sec": ttl_sec, "renew_count": 0}
    with _gpu_lease_lock:
        # Re-check under lock (TOCTOU with the active() check above).
        if _gpu_lease is not None and time.time() * 1000 < _gpu_lease["expires_ms"]:
            return JSONResponse({"error": "already_leased"}, status_code=409)
        _gpu_lease = lease

    _persist_lease_to_disk(lease)          # a proxy restart mid-lease must not drop it
    # Same drain routine game mode uses; the mode flag itself is untouched.
    vram_drain = await _drain_vram_for_gaming()
    return JSONResponse(payload)''',
            },
        },
        {
            "id": "ledger",
            "eyebrow": "The ledger",
            "title": "What each program actually spent",
            "problem": (
                "Local inference feels free because no invoice arrives, which "
                "makes it very easy to spend an evening of GPU time on something "
                "worth about four cents. The paid models are the opposite: the "
                "bill arrives monthly, long after the decision that caused it."
            ),
            "solution": (
                "A dashboard rebuilds what each program spent from the raw "
                "request logs rather than from anything the programs report about "
                "themselves. It totals the day, breaks it down per caller, tracks "
                "the cache hit rate, and prices the local work against what the "
                "same tokens would have cost from a cloud model.\n\n"
                "That last number settles arguments, because it is the "
                "difference between believing the local stack pays for itself and "
                "knowing what it saved."
            ),
            "figure": {
                "kind": "shot",
                "src": _SHOT + "cost-board.png",
                "thumb": _SHOT + "thumb-cost-board.jpg",
                "alt": "Usage cost dashboard: total cost, API calls, sessions, "
                       "cache hit rate, local GPU equivalent",
                "caption": "The cost board. It totals today's spend, cache hits, "
                           "and what the local work would have cost from a cloud "
                           "model.",
            },
        },
    ],
    "status": (
        "Running daily. Local models take the first pass at everything, and a "
        "paid model only gets called when the local one can't finish."
    ),
    "signals": "priority dispatch &middot; time-limited leases &middot; per-program spend ledger",
}


GENOME = {
    "slug": "genome",
    "github": "https://github.com/ryanzegalia/portfolio/tree/main/data-pipeline",
    "name": "Turning community game guides into offline data",
    "eyebrow": "Structured extraction",
    "pack": "genome",
    "hero": {
        "problem": "The model reads the guides and picks out the facts, but it "
                   "isn't allowed to write any of them.",
        "standfirst": "A pipeline that turns community game guides into data a "
                      "handheld can browse offline, with every line on the device "
                      "copied from a real guide.",
    },
    "sections": [
        {
            "id": "missing",
            "eyebrow": "The gap",
            "title": "The data I wanted doesn't exist anywhere",
            "problem": (
                "I wanted to browse a big game library the way you browse "
                "anything else: by mood, by how long a session takes, by how hard "
                "it is. None of that exists in any catalog you can download. "
                "Catalogs carry genre, year, and publisher, which tell you almost "
                "nothing about whether you want to play something tonight."
            ),
            "solution": (
                "The information does exist, in the guides people write about "
                "these games. It is buried in prose, phrased differently every "
                "time, and there is no field to read it out of. A model can infer "
                "it, which is the obvious move and also where the trouble starts."
            ),
            "figure": {
                "kind": "shot",
                "src": _SHOT + "genome.png?v=2",
                "thumb": _SHOT + "thumb-genome.jpg?v=2",
                "alt": "Handheld browse screen: Tense Picks and Platformers "
                       "shelves, each game stamped with session length",
                "caption": "The browse screen, running on the handheld. The "
                           "shelf names and the session-length stamps on every "
                           "box are genome fields.",
            },
        },
        {
            "id": "faithful",
            "eyebrow": "The trust model",
            "title": "The model never writes the text",
            "problem": (
                "A model asked to describe a game will make things up. Not often "
                "enough to notice while you are testing it, and often enough to "
                "matter once it has run over tens of thousands of titles. The "
                "handheld has no network, so a wrong line sits on the device with "
                "nothing to check it against and no way to correct it."
            ),
            "solution": (
                "So the model never writes fact text at all. It returns a field, "
                "the sentence it came from, and a verbatim quote. Python then "
                "searches the source guide for that quote and throws out anything "
                "that isn't there character for character. Every line on the "
                "device is copied from a real guide, with the source one tap "
                "away, and anything the model can't ground is skipped.\n\n"
                "I tried having it return character positions instead, which "
                "would have been cheaper and saved a search. It miscounted them, "
                "so I went back to searching for the quote."
            ),
            "figure": {
                "kind": "component",
                "partial": "components/systems/extraction.html",
                "caption": "Live rows out of the extraction database, one game's "
                           "pass. A kept row's text is the quote itself, found in "
                           "the guide character for character.",
                "ctx": {
                    "stat": {
                        "label": "Achievements checked against guides",
                        "value": "37,002",
                        "caption": "Across 2,215 games. Grounded text kept for "
                                   "11,077, the rest skipped rather than guess",
                        "pill": "still filling",
                    },
                    "game": {
                        "name": "Pokémon LeafGreen",
                        "sub": "Game Boy Advance, 128 achievements checked "
                               "against its guide",
                    },
                    "verdict": {"label": "grounded", "value": "60 of 128"},
                    "rows": [
                        {"name": "Catch a wild Snorlax", "kept": True,
                         "detail": "\"Be prepared with lots of Pokeballs and "
                                   "play the PokeFlute.\""},
                        {"name": "Catch Mewtwo", "kept": True,
                         "detail": "\"Don't use your Master Ball.\""},
                        {"name": "Become the Champion again", "kept": True,
                         "detail": "\"Oh, and all the trainers have Full "
                                   "Restores.\""},
                        {"name": "Obtain the Pok\u00e9dex", "kept": True,
                         "detail": "\"Skip his blabbering and get your prize - "
                                   "the Pokedex.\""},
                        {"name": "Defeat Brock", "kept": False,
                         "detail": "a quote was found, judged unhelpful for "
                                   "this one, and dropped"},
                        {"name": "Catch Zapdos", "kept": False,
                         "detail": "nothing in the guide grounds it, skipped"},
                    ],
                    "note": "3,448 quotes across the run were found verbatim and "
                            "still dropped, judged unhelpful for their achievement.",
                    "footer": {"fill_pct": 47,
                               "pill": "the other 68 are skipped, not guessed"},
                },
            },
            "code_artifact": {
                "caption": "The check every kept line has to pass",
                "language": "python",
                "source": "vllm_client.py. The JSON schema and the retry wrapper "
                          "are elided; everything that decides whether a line is "
                          "kept is here. The search runs over the whole guide, so "
                          "a quote counts as grounded wherever it appears, not "
                          "only in the sentence the model claimed.",
                "code": r'''def extract_spans(source_text, fields_desc, system_hint="", model=MODEL, base=PROXY):
    """The VALIDATED faithful-by-construction primitive.

    Sentence-segments `source_text`, asks the model for {field, sentence_id, verbatim
    quote}, then DETERMINISTICALLY resolves each quote back to a precise (start,end)
    offset and REJECTS any quote not found verbatim. The model never emits fact text
    that we keep -- Python copies the located span. Returns list of dicts:
        {field, sentence_id, quote, start, end, ok}
    Only rows with ok=True are trustworthy; ok=False rows are mispoints to drop.
    """
    sents = _sentences(source_text)
    numbered = "\n".join(f"[{i}] {s}" for i, s in enumerate(sents))
    messages = [
        {"role": "system", "content":
            "You extract from retro game guides. You NEVER invent facts. For each "
            "requested field return the sentence id it lives in and a 'quote' that is "
            "an EXACT verbatim substring copied character-for-character from that "
            "sentence (no paraphrase, no added words). If a field is not present in "
            "the guide, omit it. " + system_hint},
        {"role": "user", "content":
            "GUIDE (numbered sentences):\n" + numbered + "\n\nExtract: " + fields_desc},
    ]
    content = chat(messages, schema=schema, model=model, base=base, max_tokens=1600)
    try:
        spans = json.loads(content).get("spans", [])
    except (json.JSONDecodeError, AttributeError):
        return []

    out = []
    for s in spans:
        q, sid = s.get("quote", ""), s.get("sentence_id", -1)
        # FAITHFULNESS = the quote is verbatim-present in the source.
        start = source_text.find(q) if q else -1
        ok = bool(q and len(q) >= 3 and start >= 0)
        out.append({"field": s.get("field"), "sentence_id": sid, "quote": q,
                    "start": start, "end": start + len(q) if start >= 0 else -1,
                    "ok": ok})
    return out''',
            },
        },
        {
            "id": "canonical",
            "eyebrow": "The database",
            "title": "One canonical record, many feeds",
            "problem": (
                "Once more than one source has an opinion about a game, the "
                "obvious thing to do is let each feature read whichever source it "
                "prefers. That is how you end up with two screens on the same "
                "device disagreeing about what a game is called."
            ),
            "solution": (
                "Every external source is a feed into one database, never a "
                "parallel path to the device. Anything a new feature needs "
                "becomes a column in that database, filled by its own resumable "
                "backfill and exported through the same single file the device "
                "reads. Series names come from a metadata API first and a model "
                "only fills what the API missed, snapped back onto the canonical "
                "spelling so the two layers agree."
            ),
            "figure": {
                "kind": "shot",
                "src": _SHOT + "genome-shelves.png?v=2",
                "thumb": _SHOT + "thumb-genome-shelves.jpg?v=2",
                "alt": "Handheld browse screen: Couch Co-op shelf with player "
                       "counts and Critics' Picks shelf with rating stamps",
                "caption": "Two feeds on one screen: player counts stamp one "
                           "shelf, critic scores the next, all read out of the "
                           "same record.",
            },
        },
    ],
    "status": (
        "Still filling. More than 50,000 titles are classified and exported, "
        "driving the browse screen on the device, and the catalog pass runs "
        "continuously. So far it has kept grounded text for 11,077 of the "
        "37,002 achievements checked, and skipped the rest rather than guess."
    ),
    "signals": "every line verified against its source &middot; abstains rather than guess &middot; runs offline",
}


CAD = {
    "slug": "cad",
    "name": "Rebuilding 3D meshes into editable CAD solids",
    "eyebrow": "Computational design",
    "pack": "cad",
    "hero": {
        "problem": "I can't draw CAD from scratch, but I can usually find a "
                   "downloaded mesh close to what I need.",
        "standfirst": "Agents rebuild that mesh into a real editable solid, and "
                      "I make my changes from there.",
    },
    "sections": [
        {
            "id": "mesh",
            "eyebrow": "The problem",
            "title": "A mesh is a shell, not a shape",
            "problem": (
                "A downloaded mesh looks like the part you want and behaves "
                "nothing like it. It is a skin of triangles with no idea that it "
                "has a hole in it, or a flat face, or a fillet. There is nothing "
                "in it to grab and resize, because there is no feature there to "
                "grab. Turning one into a real solid by hand is exactly the skill "
                "I don't have."
            ),
            "solution": (
                "So the rebuild is the product: agents work the mesh back into a "
                "solid with real faces and edges, and from there it behaves like "
                "something drawn on purpose: resize it, drill it, add a bracket, "
                "and export STEP for a vendor or a print-ready 3MF for the "
                "printer downstairs."
            ),
            "figure": {
                "kind": "shot",
                "src": _SHOT + "cad-assembly.png",
                "thumb": _SHOT + "thumb-cad-assembly.jpg",
                "alt": "Rack assembly in the CAD workspace with parts list and "
                       "operation log",
                "caption": "A 58-part rack assembly rebuilt from downloaded "
                           "meshes, with the log of every operation on the right.",
            },
        },
        {
            "id": "tiers",
            "eyebrow": "The rebuild",
            "title": "Cheapest method that works, then fall back",
            "problem": (
                "There is no single conversion that handles every mesh. The fast "
                "methods work beautifully on parts that were mechanical to begin "
                "with and produce garbage on anything organic. The thorough "
                "methods handle almost anything and are slow enough that you "
                "would never run one speculatively."
            ),
            "solution": (
                "So the pipeline tries them in order, cheapest first, and falls "
                "back when a tier fails its check rather than when it errors. "
                "Most parts never reach the expensive tier. The ones that do are "
                "the ones that needed it, and I find out which is which from the "
                "operation log rather than by guessing."
            ),
            "figure": {
                "kind": "shot",
                "src": _SHOT + "cad-tray.png",
                "thumb": _SHOT + "thumb-cad-tray.jpg",
                "alt": "Device tray with three seated housings in the CAD "
                       "workspace",
                "caption": "A device tray mid-session, with three housings seated "
                           "on the patterned base.",
            },
        },
        {
            "id": "verify",
            "eyebrow": "The check",
            "title": "Measured against the mesh it came from",
            "problem": (
                "A rebuilt solid that looks right and is a millimetre off is "
                "worse than one that obviously failed, because you find out at "
                "the printer or, later, at the vendor."
            ),
            "solution": (
                "Every rebuild is compared back against the original mesh before "
                "it is accepted, and the comparison is what promotes or rejects "
                "the tier. The bench scores two different things: how close the "
                "solid is to the mesh it was rebuilt from, and, for the parts "
                "where a real STEP solid exists to check against, how close it "
                "is to that. On a four-part test bench, the strongest rebuild "
                "matches its source mesh to 99.6%. Running a published neural "
                "rebuild, CAD-Recode, over the same four parts topped out at "
                "84.8%, and it scored 30.2% on the part my pipeline rebuilds "
                "to 99.6%."
            ),
            "figure": {
                "kind": "component",
                "partial": "components/systems/pipeline.html",
                "caption": "One part's run out of the bench table. Times and "
                           "scores are the bench's own rows, not estimates.",
                "ctx": {
                    "stat": {
                        "label": "Rebuilt solid against the mesh it came from",
                        "value": "0.996",
                        "caption": "IoU on the vent panel through the extrusion "
                                   "tier, its 16 mounting holes recovered as "
                                   "editable features",
                        "pill": "bench-scored",
                    },
                    "title": "A 40 mm fan plate runs the ladder",
                    "subtitle": "Cheapest tier first, falls back on a failed "
                                "check, not a failed run",
                    "verdict": {"label": "accepted, sew tier", "value": "IoU 1.0"},
                    "gates": [
                        {"name": "Extrusion fit",
                         "checks": "sweeps one profile, keeps holes as real "
                                   "features",
                         "note": "check failed, 0.2 s"},
                        {"name": "Watertight sew",
                         "checks": "sews the shell into a solid, universal but "
                                   "not feature-editable",
                         "note": "IoU 1.000, 3.4 s"},
                        {"name": "Feature-history fit",
                         "checks": "searches for a full sequence of modeling "
                                   "steps",
                         "note": "IoU 0.354, 221 s"},
                        {"name": "Neural rebuild",
                         "checks": "a model sketches and extrudes an "
                                   "approximation",
                         "note": "IoU 0.147, 10 s"},
                    ],
                    "bracket": "The ladder stopped at the sew. The two tiers "
                               "below ran for the bench table only, and both "
                               "scored worse after costing more. The check is an "
                               "IoU floor, added after a tier once reported "
                               "success at 0.134.",
                    "footer": {"fill_pct": 100,
                               "pill": "IoU 1.0 at the second tier"},
                },
            },
            "code_artifact": {
                "caption": "One bench row: run a tier, then measure it",
                "language": "python",
                "source": "bench/bench.py. This is the harness the tier ladder is "
                          "scored by, so every number on this page comes out of a "
                          "row it printed.",
                "code": r'''def bench_recon_row(fname, tier, gt_mesh):
    p = _make_part(fname)
    base_mesh = p.mesh.copy()
    t = time.time()
    ok, err, out = True, "", None
    try:
        if tier == "recon":
            r = recon_fn(p)
            ok = bool(r.ok)
            out = p if r.ok else None
            if not r.ok:
                err = str(r.reason)[:48]
        elif tier == "tier2":
            forge.convert(p)
            out, ok = p, p.has_solid
        elif tier == "cadfit":
            from forge.recon_cadfit import reconstruct_cadfit
            out = reconstruct_cadfit(p, max_iterations=1)
            ok = out.has_solid
        elif tier == "neural":
            from forge.recon_neural import reconstruct_neural
            out = reconstruct_neural(p, device="cuda")
            ok = out.has_solid
        else:
            raise ValueError(f"unknown tier {tier!r}")
    except Exception as e:
        ok = False
        err = f"{type(e).__name__}: {str(e)[:48]}"
    dt = time.time() - t

    faces = holes_n = vol = iou_self = iou_gt = "-"   # table placeholders
    if out is not None and out.has_solid:
        faces = count_faces(out.solid)
        holes_n = len(forge_solid_holes(out))
        vol = int(round(forge.solid_volume(out.solid)))
        om = out.display_mesh()
        iou_self = voxel_iou(om, base_mesh)     # vs the mesh it was rebuilt from
        if gt_mesh is not None:
            iou_gt = voxel_iou(om, gt_mesh)     # vs the STEP solid, where one exists
    md(f"| {tier} | {('OK' if ok else 'FAIL')} | {dt:.1f} | {faces} | "
       f"{holes_n} | {vol} | {iou_self} | {iou_gt} | {err} |")''',
            },
        },
    ],
    "status": (
        "Runs live in the browser. On a four-part test bench, the strongest "
        "rebuild matches its source mesh to 99.6%. Running a published neural "
        "rebuild, CAD-Recode, over the same four parts topped out at 84.8%."
    ),
    "signals": "mesh in, STEP/3MF out &middot; agents drive the rebuild &middot; live viewer",
}


SYSTEM_REGISTRY = {s["slug"]: s for s in (JOB_PIPELINE, GPU, GENOME, CAD)}

__all__ = ["SYSTEM_REGISTRY"]
