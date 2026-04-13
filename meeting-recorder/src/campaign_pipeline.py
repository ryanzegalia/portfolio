"""Multi-pass AI processing pipeline for campaign sessions.

Processes gaming sessions through 5 passes:
  Pass 1: Transcribe each chunk (voice + game streams separately)
  Pass 2: Analyze screenshots with vision model (factual extraction)
  Pass 3: Build factual timeline from audio + screenshots
  Pass 4: Write session narrative from factual timeline
  Pass 5: Update campaign state (NPCs, quests, decisions)

All processing runs after the session ends -- zero GPU impact during gameplay.
"""

import base64
import io
import json
import os
import sys
import time
import traceback
import types
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import httpx

from config import AppConfig, SHARED_DATA_ROOT, SESSIONS_DIR
from db import get_session, Campaign, CampaignSession, SessionChunk
from pipeline import unload_ollama, ensure_ollama_running
from transcriber import load_whisperx_model, free_whisperx_model, transcribe_audio_to_text


# --- Prompts ---

SCREENSHOT_ANALYSIS_PROMPT = """\
Analyze this Baldur's Gate 3 screenshot. Transcribe ONLY text you can read on screen.
Return ONLY valid JSON, no other text:
{{"frame_type":"combat|exploration|cutscene|dialogue|inventory|menu|desktop",
"location":"location name on screen or null",
"party_hp":"all HP values shown (e.g. 32/32, 27/27)",
"enemies":"enemy names and HP if visible, or null",
"conditions":"status effects shown (Prone, Disarmed, Burning, etc) or null",
"action_log":"combat log text at bottom of screen or null",
"dialogue":"NPC dialogue or speech on screen, or null",
"ability":"spell or ability tooltip shown, or null",
"characters":"names you can READ on screen, comma separated",
"items":"any picked up messages, or null",
"notable":"dice rolls, saving throws, quest text not covered above, or null"}}
Do NOT guess names you cannot read. Write illegible if unclear. Do NOT describe UI layout.
/no_think"""

FACTUAL_TIMELINE_PROMPT = """\
Build a factual timeline of this ~10 minute gaming session chunk. Include ONLY events directly supported by the evidence below.

=== PLAYER VOICE CHAT (what the players said to each other) ===
{voice_transcript}

=== GAME AUDIO (NPC dialogue, narration, game sounds transcribed) ===
{game_transcript}

=== SCREENSHOTS (what was on screen, captured every ~60 seconds) ===
{screenshot_analyses}

Return ONLY valid JSON:
{{
  "events": [
    {{
      "time_approx": "~0:30|~1:00|early|mid|late",
      "source": "screenshot_N|voice_chat|game_audio",
      "what": "factual description of what happened"
    }}
  ],
  "location": "primary location from screenshots, or null",
  "activity_type": "combat|exploration|dialogue|cutscene|menu|mixed|unknown",
  "combat_summary": "if combat occurred: who fought whom, key abilities used, who went down, final outcome. null if no combat.",
  "player_banter": [
    "Include 3-5 of the best/funniest/most tactical direct quotes from voice chat. Transcribe them EXACTLY as spoken -- preserve slang, interruptions, trailing off. Format: 'quote text here'"
  ],
  "player_mood": "how the players sounded -- excited, frustrated, strategizing, joking around, tense, etc."
}}

RULES:
- Every event MUST cite its source (which screenshot number or audio stream).
- Do NOT add events, NPCs, quests, abilities, or dialogue not present in the evidence above.
- If evidence is sparse, return fewer events. Accuracy over completeness.
- For player_banter: pick quotes that capture personality, humor, or tension. Skip generic game instructions.
- "unknown" is always valid when evidence is unclear.
"""

SESSION_NARRATIVE_PROMPT = """\
You are writing a session recap for a Baldur's Gate 3 campaign, based STRICTLY on the evidence below.

Party: {party_members}
Session #{session_number} -- {session_date}
Duration: {duration}

=== CHUNK TIMELINES (assembled from audio transcripts and screenshots) ===
{factual_timeline}

Write a session chronicle. Return ONLY valid JSON:
{{
  "title": "3-6 word title from what ACTUALLY happened (not generic fantasy)",
  "adventure_log": "2-4 paragraph recap written like friends retelling their D&D session at a bar. Use the actual player quotes from the timelines -- they're the soul of the recap. Describe what the PLAYERS did and said, not just what their characters did. Include funny moments, frustrations, close calls, and tactical arguments.",
  "chapters": [
    {{
      "title": "Chapter title",
      "time_range": "approximate time range",
      "summary": "What happened in this stretch"
    }}
  ],
  "best_quotes": [
    {{"text": "exact quote from player_banter in the timelines", "context": "what was happening when they said it"}}
  ],
  "combat_encounters": [
    {{"enemy": "who they fought", "outcome": "what happened", "mvp_moment": "best play or worst fail"}}
  ],
  "deaths_and_downs": ["list every time a party member went down or died, with context"],
  "loot": ["items picked up or crafted, from the timelines only"],
  "npcs_encountered": [
    {{"name": "NPC name", "context": "how they appeared -- ONLY names visible on screen or in audio"}}
  ],
  "session_vibe": {{
    "primary_activity": "combat|exploration|dialogue|mixed",
    "mood": "how the players felt -- based on their actual quotes and tone",
    "highlight": "single best moment",
    "lowlight": "most frustrating or funniest fail moment"
  }}
}}

ABSOLUTE RULES -- VIOLATION MEANS THE RECAP IS USELESS:
- NEVER add spells, abilities, items, NPCs, quests, or events not explicitly in the timelines above.
- NEVER use your knowledge of BG3 to fill in details. If it's not in the evidence, it didn't happen.
- If you can't identify who said a quote, attribute it to "someone" not a specific player.
- Short and accurate beats long and padded. A 2-paragraph recap of a sparse session is perfect.
- The best recaps feel like reading a group chat recap, not a fantasy novel.
"""

RECAP_PROMPT = """\
Write a "Previously On..." recap to read aloud at the start of the next session.

Party: {party_members}
Session #{session_number}: "{session_title}"

What happened:
{adventure_log}

Best moments: {best_quotes}

Vibe: {session_vibe}

Write 2-3 paragraphs in second person ("You..."). Start with "When last we left our heroes..." or similar.
Keep the tone matching the session vibe -- if they were joking around, keep it light. If it was tense, lean into that.
Include a callback to the best quote if it's funny or dramatic enough.

IMPORTANT: Only reference events from the adventure log above. Do not add any events or details not mentioned.

Return ONLY the recap text, no JSON wrapper.
"""

CAMPAIGN_UPDATE_PROMPT = """\
You are tracking the running state of a Baldur's Gate 3 campaign.

Party: {party_members}

Current campaign state:
NPC Registry: {current_npcs}
Quest Log: {current_quests}
Decision History: {current_decisions}

New session #{session_number} data:
NPCs encountered: {new_npcs}
Combat encounters: {new_encounters}
Loot acquired: {new_loot}
Deaths/downs: {new_deaths}

Update the campaign state by merging the new session data. Return ONLY valid JSON:
{{
  "npc_registry": [
    {{"name": "NPC name", "disposition": "friendly|neutral|hostile|dead", "location": "where last seen", "last_session": {session_number}, "notes": "key info"}}
  ],
  "quest_log": [
    {{"name": "quest or objective", "status": "active|completed|failed", "last_update_session": {session_number}, "detail": "current state"}}
  ],
  "decision_history": [
    {{"session": {session_number}, "what": "what happened or was decided", "consequence": "result if known"}}
  ]
}}

RULES:
- Preserve ALL existing entries. Only add/update based on new session data.
- Mark defeated bosses as "dead" in NPC registry.
- Add significant loot to decision_history (e.g. "Crafted Adamantine Splint Armour").
- Do NOT invent entries not supported by the session data above.
"""


# --- Incremental DB helpers (save-as-you-go, resume on restart) ---

def _load_chunk_transcript(chunk_id) -> dict | None:
    """Load existing transcript from DB, or None if not yet transcribed."""
    db = get_session()
    try:
        sc = db.query(SessionChunk).get(chunk_id)
        if sc and sc.transcript_json:
            return json.loads(sc.transcript_json)
    finally:
        db.close()
    return None


def _save_chunk_transcript(chunk_id, transcript: dict):
    """Save transcript to DB immediately."""
    db = get_session()
    try:
        sc = db.query(SessionChunk).get(chunk_id)
        if sc:
            sc.transcript_json = json.dumps(transcript)
            db.commit()
    finally:
        db.close()


def _load_chunk_screenshots(chunk_id) -> list | None:
    """Load existing screenshot analyses, or None if not yet analyzed."""
    db = get_session()
    try:
        sc = db.query(SessionChunk).get(chunk_id)
        if sc and sc.analysis_json:
            data = json.loads(sc.analysis_json)
            if "screenshots" in data:
                return data["screenshots"]
    finally:
        db.close()
    return None


def _save_chunk_screenshots(chunk_id, analyses: list):
    """Save screenshot analyses to DB immediately."""
    db = get_session()
    try:
        sc = db.query(SessionChunk).get(chunk_id)
        if sc:
            existing = json.loads(sc.analysis_json) if sc.analysis_json else {}
            existing["screenshots"] = analyses
            sc.analysis_json = json.dumps(existing)
            db.commit()
    finally:
        db.close()


def _load_chunk_timeline(chunk_id) -> dict | None:
    """Load existing timeline, or None if not yet built."""
    db = get_session()
    try:
        sc = db.query(SessionChunk).get(chunk_id)
        if sc and sc.analysis_json:
            data = json.loads(sc.analysis_json)
            if "timeline" in data:
                return data["timeline"]
    finally:
        db.close()
    return None


def _save_chunk_timeline(chunk_id, timeline_data: dict):
    """Save timeline to DB, merging with existing analysis_json."""
    db = get_session()
    try:
        sc = db.query(SessionChunk).get(chunk_id)
        if sc:
            existing = json.loads(sc.analysis_json) if sc.analysis_json else {}
            existing["timeline"] = timeline_data
            sc.analysis_json = json.dumps(existing)
            db.commit()
    finally:
        db.close()


def run_campaign_pipeline(
    session_id: str,
    config: AppConfig,
    sync_worker,
    on_complete: Callable[[dict], None] | None = None,
    on_error: Callable[[str], None] | None = None,
):
    """Run the full multi-pass campaign processing pipeline.

    Pass 1: Transcribe each chunk
    Pass 2: Analyze screenshots with vision model
    Pass 3: Build factual timeline
    Pass 4: Write session narrative
    Pass 5: Update campaign state
    """
    start_time = time.time()

    try:
        # Load session data
        db_session = get_session()
        try:
            cs = db_session.query(CampaignSession).get(session_id)
            if not cs:
                raise ValueError(f"Campaign session {session_id} not found")

            campaign = db_session.query(Campaign).get(cs.campaign_id)
            if not campaign:
                raise ValueError(f"Campaign {cs.campaign_id} not found")

            chunk_rows = (
                db_session.query(SessionChunk)
                .filter(SessionChunk.session_id == session_id)
                .order_by(SessionChunk.chunk_index)
                .all()
            )

            chunks = []
            for c in chunk_rows:
                chunks.append(types.SimpleNamespace(
                    id=c.id,
                    chunk_index=c.chunk_index,
                    mic_audio_path=c.mic_audio_path,
                    discord_audio_path=getattr(c, "discord_audio_path", None),
                    game_audio_path=getattr(c, "game_audio_path", None),
                    mixed_audio_path=getattr(c, "mixed_audio_path", None),
                    duration_seconds=c.duration_seconds,
                    screenshot_paths=c.screenshot_paths,
                ))

            party_members = json.loads(campaign.party_members or "[]")
            party_str = ", ".join(party_members) if party_members else "Unknown party"
            session_number = cs.session_number or 1

            cs.processing_status = "processing"
            db_session.commit()
        finally:
            db_session.close()

        if not chunks:
            raise ValueError("No chunks found for session")

        print(f"[campaign] Starting pipeline for session {session_id[:8]}, "
              f"{len(chunks)} chunks")

        # Free VRAM before WhisperX
        unload_ollama(config.ollama_url, config.ollama_model)

        # --- Pass 1: Transcribe each chunk (resumable) ---
        print("[campaign] Pass 1: Transcribing chunks...")
        chunk_transcripts = []
        needs_transcription = any(
            _load_chunk_transcript(c.id) is None for c in chunks
        )
        if needs_transcription:
            whisper_model, whisper_device = load_whisperx_model()
        else:
            whisper_model = whisper_device = None
        try:
            for chunk in chunks:
                existing = _load_chunk_transcript(chunk.id)
                if existing:
                    chunk_transcripts.append(existing)
                    print(f"[campaign]   Chunk {chunk.chunk_index}: already transcribed, skipping")
                    continue
                transcript = _transcribe_chunk(chunk, session_id, config, whisper_model=whisper_model)
                _save_chunk_transcript(chunk.id, transcript)
                chunk_transcripts.append(transcript)
                print(f"[campaign]   Chunk {chunk.chunk_index}: "
                      f"voice={len(transcript.get('voice_text', ''))} chars, "
                      f"game={len(transcript.get('game_text', ''))} chars")
        finally:
            if whisper_model is not None:
                free_whisperx_model(whisper_model, whisper_device)

        # Abort if no audio was transcribed at all
        total_chars = sum(
            len(t.get("voice_text", "")) + len(t.get("game_text", ""))
            for t in chunk_transcripts
        )
        if total_chars == 0:
            raise ValueError(
                "No audio was transcribed -- all chunks returned empty. "
                "Check that ffmpeg is installed and audio files are valid MP3s."
            )

        # --- Pass 2: Analyze screenshots with vision model (resumable) ---
        print("[campaign] Pass 2: Analyzing screenshots with vision model...")
        ensure_ollama_running(config.ollama_url)

        chunk_screenshot_analyses = []
        for chunk in chunks:
            existing = _load_chunk_screenshots(chunk.id)
            if existing is not None:
                chunk_screenshot_analyses.append(existing)
                print(f"[campaign]   Chunk {chunk.chunk_index}: "
                      f"{len(existing)} screenshots already analyzed, skipping")
                continue
            analyses = _analyze_screenshots(chunk, session_id, config)
            _save_chunk_screenshots(chunk.id, analyses)
            chunk_screenshot_analyses.append(analyses)
            game_frames = sum(1 for a in analyses if a.get("frame_type") not in ("desktop", "other"))
            print(f"[campaign]   Chunk {chunk.chunk_index}: "
                  f"{len(analyses)} screenshots analyzed ({game_frames} game frames)")

        # --- Pass 3: Build factual timeline per chunk ---
        print("[campaign] Pass 3: Building factual timeline...")

        chunk_timelines = []
        for i, (chunk, transcript) in enumerate(zip(chunks, chunk_transcripts)):
            existing_timeline = _load_chunk_timeline(chunk.id)
            if existing_timeline:
                chunk_timelines.append(existing_timeline)
                print(f"[campaign]   Chunk {chunk.chunk_index}: timeline already built, skipping")
                continue

            screenshot_text = _format_screenshot_analyses(chunk_screenshot_analyses[i])

            timeline = _call_ollama(
                FACTUAL_TIMELINE_PROMPT.format(
                    voice_transcript=transcript.get("voice_text", "")[:5000] or "(no voice audio captured)",
                    game_transcript=transcript.get("game_text", "")[:3000] or "(no game audio captured)",
                    screenshot_analyses=screenshot_text or "(no screenshots)",
                ),
                config,
                temperature=0.1,
                num_predict=4096,
            )
            timeline_data = _parse_json(timeline)
            chunk_timelines.append(timeline_data)

            n_events = len(timeline_data.get("events", []))
            activity = timeline_data.get("activity_type", "unknown")
            print(f"[campaign]   Chunk {chunk.chunk_index}: "
                  f"{n_events} events, activity={activity}")

            _save_chunk_timeline(chunk.id, timeline_data)

        # --- Pass 4: Write session narrative ---
        print("[campaign] Pass 4: Writing session narrative...")

        # Build combined timeline text for narrative prompt
        combined_timeline = ""
        for i, timeline in enumerate(chunk_timelines):
            time_start = i * (config.campaign_chunk_interval // 60)
            time_end = (i + 1) * (config.campaign_chunk_interval // 60)
            combined_timeline += f"\n--- {time_start}:00 - {time_end}:00 ---\n"
            combined_timeline += json.dumps(timeline, indent=2)[:3000]
            combined_timeline += "\n"

        session_date = ""
        db_session = get_session()
        try:
            cs = db_session.query(CampaignSession).get(session_id)
            if cs and cs.started_at:
                session_date = cs.started_at.strftime("%B %d, %Y")
        finally:
            db_session.close()

        duration_min = sum(c.get("duration_seconds", 0) for c in chunk_transcripts) / 60
        duration_str = f"{int(duration_min // 60)}h {int(duration_min % 60)}m"

        narrative = _call_ollama(
            SESSION_NARRATIVE_PROMPT.format(
                party_members=party_str,
                session_number=session_number,
                session_date=session_date,
                duration=duration_str,
                factual_timeline=combined_timeline,
            ),
            config,
            temperature=0.4,
            num_predict=8192,
        )
        narrative_data = _parse_json(narrative)

        # Generate "Previously On..." recap
        print("[campaign] Generating recap...")
        recap_text = _call_ollama(
            RECAP_PROMPT.format(
                party_members=party_str,
                session_number=session_number,
                session_title=narrative_data.get("title", "Untitled Session"),
                adventure_log=narrative_data.get("adventure_log", "")[:3000],
                best_quotes=json.dumps(narrative_data.get("best_quotes", []))[:1000],
                session_vibe=json.dumps(narrative_data.get("session_vibe", {}))[:500],
            ),
            config,
            temperature=0.4,
            num_predict=2048,
        )

        # --- Pass 5: Update campaign state ---
        print("[campaign] Pass 5: Updating campaign state...")

        db_session = get_session()
        try:
            campaign = db_session.query(Campaign).get(
                db_session.query(CampaignSession).get(session_id).campaign_id
            )
            current_npcs = campaign.npc_registry or "[]"
            current_quests = campaign.quest_log or "[]"
            current_decisions = campaign.decision_history or "[]"
        finally:
            db_session.close()

        campaign_update = _call_ollama(
            CAMPAIGN_UPDATE_PROMPT.format(
                party_members=party_str,
                session_number=session_number,
                current_npcs=current_npcs[:3000],
                current_quests=current_quests[:3000],
                current_decisions=current_decisions[:3000],
                new_npcs=json.dumps(narrative_data.get("npcs_encountered", []))[:2000],
                new_encounters=json.dumps(narrative_data.get("combat_encounters", []))[:2000],
                new_loot=json.dumps(narrative_data.get("loot", []))[:2000],
                new_deaths=json.dumps(narrative_data.get("deaths_and_downs", []))[:1000],
            ),
            config,
            temperature=0.1,
            num_predict=4096,
        )
        campaign_state = _parse_json(campaign_update)

        # --- Save everything to DB ---
        elapsed = round(time.time() - start_time, 1)
        print(f"[campaign] Pipeline complete in {elapsed}s. Saving results...")

        db_session = get_session()
        try:
            cs = db_session.query(CampaignSession).get(session_id)
            if cs:
                cs.title = narrative_data.get("title", "Untitled Session")
                cs.narrative_json = json.dumps(narrative_data)
                cs.recap_text = recap_text
                cs.stats_json = json.dumps(narrative_data.get("session_vibe", {}))
                cs.processing_status = "completed"
                cs.processing_error = None
                cs.synced_at = None  # Force re-sync

            campaign = db_session.query(Campaign).get(cs.campaign_id)
            if campaign and campaign_state:
                campaign.npc_registry = json.dumps(
                    campaign_state.get("npc_registry", [])
                )
                campaign.quest_log = json.dumps(
                    campaign_state.get("quest_log", [])
                )
                campaign.decision_history = json.dumps(
                    campaign_state.get("decision_history", [])
                )
                campaign.synced_at = None

            db_session.commit()
        finally:
            db_session.close()

        # Trigger sync
        if sync_worker:
            sync_worker.sync_now()

        print(f"[campaign] Session '{narrative_data.get('title', '?')}' complete!")

        if on_complete:
            on_complete(narrative_data)

    except Exception as e:
        error_msg = f"{type(e).__name__}: {e}"
        print(f"[campaign] Pipeline failed: {error_msg}")
        traceback.print_exc()

        db_session = get_session()
        try:
            cs = db_session.query(CampaignSession).get(session_id)
            if cs:
                cs.processing_status = "failed"
                cs.processing_error = error_msg
                cs.synced_at = None
                db_session.commit()
        finally:
            db_session.close()

        if on_error:
            on_error(error_msg)


def _transcribe_chunk(chunk: SessionChunk, session_id: str, config: AppConfig, whisper_model=None) -> dict:
    """Transcribe a single chunk's audio streams."""
    result = {"chunk_index": chunk.chunk_index, "voice_text": "", "game_text": ""}

    voice_paths = []
    if chunk.mic_audio_path:
        mic_path = SHARED_DATA_ROOT / chunk.mic_audio_path
        if mic_path.exists():
            voice_paths.append(mic_path)
    if chunk.discord_audio_path:
        discord_path = SHARED_DATA_ROOT / chunk.discord_audio_path
        if discord_path.exists():
            voice_paths.append(discord_path)

    if not voice_paths and chunk.mixed_audio_path:
        mixed_path = SHARED_DATA_ROOT / chunk.mixed_audio_path
        if mixed_path.exists():
            voice_paths.append(mixed_path)

    if voice_paths:
        voice_text = transcribe_audio_to_text(voice_paths[0], model=whisper_model)
        if len(voice_paths) > 1:
            discord_text = transcribe_audio_to_text(voice_paths[1], model=whisper_model)
            voice_text = f"{voice_text}\n{discord_text}" if discord_text else voice_text
        result["voice_text"] = voice_text

    if chunk.game_audio_path:
        game_path = SHARED_DATA_ROOT / chunk.game_audio_path
        if game_path.exists():
            result["game_text"] = transcribe_audio_to_text(game_path, model=whisper_model)

    result["duration_seconds"] = chunk.duration_seconds or 0
    return result


def _analyze_screenshots(chunk, session_id: str, config: AppConfig, sample_every: int = 4) -> list[dict]:
    """Analyze screenshots in a chunk using the vision model.

    Samples every Nth screenshot to keep processing time reasonable.
    At 15s capture interval with sample_every=4, analyzes one frame per minute.
    """
    if not chunk.screenshot_paths:
        return []

    try:
        paths = json.loads(chunk.screenshot_paths)
    except (json.JSONDecodeError, TypeError):
        return []

    if not paths:
        return []

    # Sample every Nth screenshot
    sampled = [(i, p) for i, p in enumerate(paths) if i % sample_every == 0]
    print(f"[campaign]     Sampling {len(sampled)}/{len(paths)} screenshots "
          f"(every {sample_every}th frame)", flush=True)

    analyses = []
    for i, rel_path in sampled:
        screenshot_path = SESSIONS_DIR / session_id / "screenshots" / rel_path
        if not screenshot_path.exists():
            continue

        try:
            raw = _call_ollama_vision(
                SCREENSHOT_ANALYSIS_PROMPT,
                [screenshot_path],
                config,
                temperature=0.1,
                num_predict=2048,
            )
        except Exception as e:
            print(f"[campaign]     Screenshot {screenshot_path.name} skipped: {e}",
                  flush=True)
            continue
        analysis = _parse_json(raw)
        analysis["frame_index"] = i
        analysis["filename"] = screenshot_path.name
        analyses.append(analysis)
        print(f"[campaign]     [{len(analyses)}/{len(sampled)}] {screenshot_path.name}: "
              f"{analysis.get('frame_type', '?')}", flush=True)

    return analyses


def _format_screenshot_analyses(analyses: list[dict]) -> str:
    """Format screenshot analyses as text for the timeline prompt."""
    if not analyses:
        return ""

    def _str(val) -> str:
        """Coerce any value to a clean string (handles dicts/lists from model)."""
        if val is None:
            return ""
        if isinstance(val, str):
            return val.strip()
        if isinstance(val, dict):
            # Pull out meaningful text from nested dicts
            parts = []
            for v in val.values():
                s = _str(v)
                if s:
                    parts.append(s)
            return " | ".join(parts)
        if isinstance(val, list):
            return ", ".join(_str(item) for item in val if _str(item))
        return str(val).strip()

    # Field mapping: key -> display label (covers both new and old prompt formats)
    field_map = [
        ("location", "Location"),
        ("enemies", "Enemies"),
        ("conditions", "Conditions"),
        ("party_hp", "Party HP"),
        ("action_log", "Actions"),
        ("dialogue", "Dialogue"),
        ("ability", "Ability"),
        ("characters", "Characters"),
        ("items", "Items"),
        ("notable", "Notable"),
        # Old format fallbacks
        ("on_screen_text", "Text"),
        ("action_text", "Actions"),
        ("dialogue_text", "Dialogue"),
        ("ability_shown", "Ability"),
        ("characters_visible", "Characters"),
        ("items_picked_up", "Items"),
        ("ui_state", "UI"),
        ("notable_details", "Details"),
    ]

    parts = []
    for a in analyses:
        frame_type = _str(a.get("frame_type")) or "unknown"
        if frame_type in ("desktop", "other"):
            continue

        idx = a.get("frame_index", "?")
        lines = [f"Screenshot #{idx} [{frame_type}]:"]
        seen_labels = set()

        for key, label in field_map:
            if label in seen_labels:
                continue
            val = _str(a.get(key))
            if val and val != "null":
                lines.append(f"  {label}: {val}")
                seen_labels.add(label)

        # Handle nested combat_state from old format
        combat = a.get("combat_state")
        if isinstance(combat, dict) and "Enemies" not in seen_labels:
            for sub_key, sub_label in [("enemies", "Enemies"), ("conditions", "Conditions"), ("whose_turn", "Turn")]:
                val = _str(combat.get(sub_key))
                if val and val != "null" and sub_label not in seen_labels:
                    lines.append(f"  {sub_label}: {val}")
                    seen_labels.add(sub_label)

        parts.append("\n".join(lines))

    return "\n\n".join(parts)


def _call_ollama(prompt: str, config: AppConfig, temperature: float = 0.1, num_predict: int = 4096) -> str:
    """Call Ollama text model and return raw response text."""
    resp = httpx.post(
        f"{config.ollama_url.rstrip('/')}/api/generate",
        json={
            "model": config.ollama_model,
            "prompt": prompt,
            "stream": False,
            "keep_alive": "5m",
            "options": {"temperature": temperature, "num_predict": num_predict},
        },
        timeout=600.0,
    )
    resp.raise_for_status()
    return resp.json().get("response", "")


def _call_ollama_vision(
    prompt: str,
    image_paths: list[Path],
    config: AppConfig,
    temperature: float = 0.1,
    num_predict: int = 2048,
) -> str:
    """Call Ollama vision model with images and return raw response text.

    Converts WebP/other formats to JPEG and resizes large images to keep
    payloads small and avoid empty responses from models that don't support WebP.
    """
    from PIL import Image as PILImage

    images_b64 = []
    for p in image_paths:
        img = PILImage.open(p)
        # Resize if wider than 1920px (saves bandwidth + VRAM)
        if img.width > 1920:
            ratio = 1920 / img.width
            img = img.resize((1920, int(img.height * ratio)), PILImage.Resampling.LANCZOS)
        # Convert to JPEG (universally supported by vision models)
        buf = io.BytesIO()
        img.convert("RGB").save(buf, format="JPEG", quality=80)
        images_b64.append(base64.b64encode(buf.getvalue()).decode("utf-8"))

    # Use chat API -- generate API doesn't properly separate thinking from output
    resp = httpx.post(
        f"{config.ollama_url.rstrip('/')}/api/chat",
        json={
            "model": config.ollama_vision_model,
            "messages": [{"role": "user", "content": prompt, "images": images_b64}],
            "stream": False,
            "keep_alive": "5m",
            "think": False,
            "options": {"temperature": temperature, "num_predict": num_predict},
        },
        timeout=600.0,
    )
    resp.raise_for_status()
    result = resp.json().get("message", {}).get("content", "")
    # Strip any thinking tags that leaked through
    if "</think>" in result:
        result = result.split("</think>", 1)[-1].strip()
    return result


def _parse_json(text: str) -> dict:
    """Parse JSON from model response, handling common issues."""
    if not text:
        return {}

    # Try direct parse first
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Try to find JSON in the response (between { and })
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            pass

    # Try to find JSON array
    start = text.find("[")
    end = text.rfind("]")
    if start >= 0 and end > start:
        try:
            return {"items": json.loads(text[start:end + 1])}
        except json.JSONDecodeError:
            pass

    return {"raw_text": text[:500]}
