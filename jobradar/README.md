# JobRadar

Job discovery and application generation platform spanning two machines.

> This directory is a source excerpt from the working repo. The full codebase is private; I can share access during an interview on request.

| | |
|---|---|
| **Stack** | FastAPI, PostgreSQL, React, Ollama (qwen3.5:27b), Claude Code |
| **Lines** | ~2,300 (core), plus workstation AppGen service |
| **Sources** | Ashby, Greenhouse, Lever, Remotive, RemoteOK, LinkedIn/Indeed/Glassdoor |
| **Architecture** | Server (scraping + scoring + dashboard) + Workstation (AI generation) |

## What It Does

JobRadar scrapes job postings from six sources, scores them through a multi-stage pipeline that minimizes expensive LLM calls, and generates tailored application materials via a Claude-powered agent on a separate machine.

The scoring pipeline processes hundreds of postings per day. The application generator produces a resume, cover letter, interview prep, and company research -- all from a structured accomplishments database matched against the job description.

## Architecture

```text
Scraper Sources (6)                    Scoring Pipeline
├── Ashby (company watchlist) ──→  Phase 1: Title screen (40+ reject patterns)
├── Greenhouse (watchlist)    ──→  Phase 2: Keyword analysis (section-weighted JD parsing)
├── Lever (watchlist)         ──→  Phase 3: Fit filter (6-check consensus)
├── Remotive (categories)     ──→  Phase 3.5: Keyword gate (< 30 = skip LLM)
├── RemoteOK (aggregator)     ──→  Phase 4: Fast rejection (>= 2 blockers = skip LLM)
└── JobSpy (LinkedIn/Indeed)  ──→  Phase 5: Ollama gatekeeper (LLM is authority)
                                   Phase 6: Final score reconciliation
                                        │
                              Score >= 70 → Discord alert
                                        │
                              ┌─────────┴──────────┐
                              │  Application Gen    │
                              │  (Workstation)      │
                              │                     │
                              │  Company research   │
                              │  JD intelligence    │
                              │  Resume tailoring   │
                              │  Cover letter       │
                              │  Interview prep     │
                              │  Bullet defense     │
                              └─────────────────────┘
```

## Scoring Pipeline

The pipeline is designed to reject fast and score slow. Most postings are eliminated by Phase 3.5 without touching the LLM.

**Phase 1 -- Title screen.** 40+ regex patterns reject titles that are clearly wrong: engineering roles, sales, customer support, executive positions. This runs in microseconds.

**Phase 2 -- Keyword analysis.** Parses the job description into sections (responsibilities, requirements, qualifications) and extracts metadata. Requirement matching weights terms by position in the document, section type, and repetition frequency. An euphemism database (YAML) disambiguates terms like "automation" that mean different things in different contexts. Role type detection classifies postings into categories (revops, marops, bizops, etc.) for downstream filtering.

**Phase 3 -- Fit filter.** Six independent checks vote on fit: remote work, salary floor, role type, experience match, red flag count, and company stage. Two or more blockers trigger fast rejection. Configurable red and green flag detection tuned to personal job search preferences.

**Phase 3.5 -- Keyword gate.** If the keyword score is below 30, the posting is rejected without calling Ollama. This is the primary cost optimization -- most postings that score below 30 on keywords won't be rescued by semantic analysis.

**Phase 4 -- Fast rejection.** If the title screen failed or the fit filter found two or more blocking issues, the posting is archived immediately without calling the LLM. This catches postings that passed the keyword gate but have structural problems -- wrong location, salary below floor, too many red flags.

**Phase 5 -- Ollama gatekeeper.** The LLM (qwen3.5:27b running locally) receives the full job description alongside a structured candidate profile and scores on a 0-100 scale with rationale. The prompt includes competitiveness analysis by company size, title mismatch handling, and tool-mention-vs-tool-mandate distinctions. The LLM score takes precedence when available -- keyword scoring is the fallback if Ollama is unavailable.

**Phase 6 -- Final score reconciliation.** When Ollama scores a posting, its score becomes the final score and its go/no-go/maybe decision is authoritative. When Ollama is unavailable (workstation off), the keyword score is used as fallback. Jobs with a no-go decision are auto-archived.

## Multi-Source Scraper Framework

Six scraper sources share a common `BaseScraper` interface providing HTML stripping, remote work detection, salary parsing (handles K/M shorthand, validates $20K-$500K range), and MD5-based stable external IDs for deduplication.

Three sources (Ashby, Greenhouse, Lever) scrape from a company watchlist -- specific companies whose job boards are monitored. Three sources (Remotive, RemoteOK, JobSpy) do category or keyword-based searches. The `ScraperRunner` orchestrates all sources with a unified upsert that resets scores when a job description changes (the posting was updated, previous score may not apply).

## Application Generation

When a high-scoring job is selected for application, the dashboard triggers the workstation-hosted AppGen service -- a Claude Code agent that generates application materials.

The orchestration pattern: POST to `/generate` with the job description and metadata, poll `/status` until complete, GET `/result` for the full package. Auto-recovery handles stuck generations (>20 minute timeout). Company research is cached and reused across applications for the same company.

The accomplishments database is a structured YAML file mapping experience, systems built, and quantified outcomes to role-specific language. The keyword scorer and LLM scorer both reference this database to assess how well a posting matches actual experience.

## Source Files

| File | Lines | What It Shows |
|------|-------|---------------|
| [scoring_orchestrator.py](src/scoring_orchestrator.py) | 192 | 6-phase pipeline with progressive filtering and early rejection |
| [keyword_scorer.py](src/keyword_scorer.py) | 528 | Euphemism decoding, section-weighted JD analysis, multi-factor requirement matching |
| [base_scraper.py](src/base_scraper.py) | 89 | Scraper interface with salary parsing, remote detection, stable ID generation |
| [applications.py](src/applications.py) | 438 | Multi-machine AppGen orchestration, research caching, auto-recovery |