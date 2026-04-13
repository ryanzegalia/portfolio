# Meeting Recorder

Real-time audio capture and AI processing system for meetings and tabletop gaming sessions.

> This directory is a source excerpt from the working repo. The full codebase is private; I can share access during an interview on request.

| | |
|---|---|
| **Stack** | Python, PyAudioWPatch, WhisperX, Ollama, bettercam, comtypes |
| **Lines** | ~13,000 |
| **Platform** | Windows 10/11 (WASAPI, DXGI, COM) |
| **Hardware** | RTX 5090 (GPU transcription), WASAPI loopback (audio capture) |

## What It Does

A headless daemon that captures audio (mic + system), transcribes it locally on GPU, and produces AI-generated summaries. Runs as a system tray application with global hotkeys. Recordings sync to a web dashboard via WebSocket for review and search.

Two recording modes: standard meetings (mic + system loopback) and campaign sessions (per-process audio + screenshots + multi-pass AI processing).

## Architecture

```text
Standard Recording:
  Mic ──→ PyAudio ──→ MP3 encode ──→ WhisperX (GPU) ──→ Ollama summary ──→ Dashboard sync

Campaign Session (BG3):
  Discord audio ──→ ┐
  BG3 game audio ──→ ├──→ Chunked MP3 (10-min rotation) ──→ WhisperX (GPU)
  Mic audio ────────→ ┘                                           │
  Screenshots ──────→ DXGI capture ──→ Ollama vision model         │
                                           │                       │
                                    Pass 1: Transcribe each chunk  │
                                    Pass 2: Analyze screenshots ←──┘
                                    Pass 3: Build factual timeline
                                    Pass 4: Write session narrative
                                    Pass 5: Update campaign state (NPCs, quests, decisions)
                                           │
                                    "Previously On..." recap for next session
```

## Per-Process Audio Capture

Windows WASAPI normally captures all system audio as one mixed stream. To get Discord voice chat and BG3 game audio as separate, clean streams, the recorder uses the WASAPI Process Loopback API introduced in Windows 10 2004 (Build 19041).

This API (`ActivateAudioInterfaceAsync` with `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`) captures the audio output of a specific process by PID. The catch: `IAudioClient` and `IAudioCaptureClient` aren't in any COM type library, so the code defines them manually with correct vtable layout using comtypes. The async activation callback required a raw ctypes COM implementation.

`MultiProcessCapture` handles the discovery problem. Discord is an Electron app that spreads audio across child processes -- you can't just find `discord.exe` and capture it. The code finds ALL matching PIDs via `psutil.process_iter()`, then quick-tests each one by attempting activation. The PID that successfully activates is the one with an active audio session. If no PID has audio yet (Discord hasn't joined a voice channel), the stream retries with exponential backoff up to 12 times.

Three separate audio streams (mic, Discord, BG3) plus a WASAPI loopback fallback that captures all system audio as a safety net. The chunked recorder rotates every 10 minutes, encoding each chunk to MP3 in a background thread. 
## Campaign AI Pipeline

After a session ends, a 5-pass pipeline processes the recording:

**Pass 1 -- Transcription.** WhisperX runs on the local GPU (RTX 5090: 52s of audio in ~7s). Voice and game audio streams are transcribed separately. The WhisperX model is loaded once and reused across chunks, then freed before Ollama needs VRAM.

**Pass 2 -- Screenshot analysis.** Every Nth screenshot is sent to Ollama's vision model with a structured extraction prompt: frame type (combat/exploration/cutscene/dialogue), location, party HP, enemies, dialogue on screen, action log text, ability tooltips. The prompt forces JSON output and prohibits guessing names that aren't readable on screen.

**Pass 3 -- Factual timeline.** Per-chunk timelines are built from audio transcripts + screenshot analyses. Every event must cite its source (which screenshot or audio stream). No events, NPCs, or abilities are added that aren't in the evidence. This is the grounding layer -- accuracy over completeness.

**Pass 4 -- Session narrative.** A full chronicle written from the factual timelines. Includes an adventure log, chapter breakdown, combat encounters, deaths/downs, loot, NPCs encountered, and a session vibe summary. Player quotes are preserved verbatim from the voice transcripts. Also generates a "Previously On..." recap for reading aloud at the next session.

**Pass 5 -- Campaign state update.** Merges new session data into the running campaign state: NPC registry (name, disposition, location, last seen), quest log (status, last update), decision history. Preserves all existing entries and only adds/updates based on new evidence.

Each pass saves results to the database incrementally. If the pipeline crashes or is restarted, it skips completed work and resumes from where it left off.

## Screenshot Capture

Uses bettercam (DXGI Desktop Duplication API) instead of mss (GDI BitBlt). GDI-based capture (used by mss) returns stale or cached frames for fullscreen DirectX games. DXGI captures the actual GPU framebuffer.

The BG3 window is located via `EnumWindows` + `GetWindowThreadProcessId` with process name matching process name matching. Window bounds use `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` for accurate dimensions in borderless mode, falling back to `GetWindowRect` for windowed mode.

Duplicate frame detection uses hash-based duplicate detection to skip screenshots when the screen hasn't changed -- common during dialogue or inventory screens.

## Source Files

| File | Lines | What It Shows |
|------|-------|---------------|
| [process_audio.py](src/process_audio.py) | 819 | WASAPI per-process audio capture, multi-PID discovery |
| [campaign_pipeline.py](src/campaign_pipeline.py) | 841 | 5-pass AI pipeline with structured prompts, resumable processing, campaign state |
| [chunked_audio.py](src/chunked_audio.py) | 420 | Multi-hour chunked recording with per-process streams, background MP3 encoding |
| [screenshot.py](src/screenshot.py) | 269 | DXGI Desktop Duplication, window detection, duplicate frame filtering |
