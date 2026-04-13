# Development Methodology

Claude Code is the primary development environment for everything in this portfolio -- configured as a development platform with hooks, agents, memory, and automated checks.

This document describes how the system works -- what runs, when, and why.

## The Problem It Solves

A codebase with 58 services, 145 database tables, and 15 external integrations has too much context for any single conversation. The Python 2.7 bridge has different rules than the Python 3 API. The tax engine tax integration has gotchas that cost a day to rediscover. The legacy ERP has undocumented behaviors you learn once and can't afford to forget.

The system's job is to make every conversation start with the right context already loaded, without special prompting or manual setup.

## What Happens When You Type a Message

A request like "fix the button on my sales tax page" triggers a six-layer context cascade before Claude reads the message:

**1. CLAUDE.md** loads at conversation start. Contains the project architecture, file locations, API route map, security rules, agent definitions, and confirmation rules. Claude already knows which files exist, what they do, and how they connect.

**2. Memory files** persist across conversations. An index (`MEMORY.md`) points to topic files covering lessons learned, vendor quirks, deployment patterns, and past bugs. Things like "the ERP silently rejects some price edits" or "the Python 2.7 bridge has a max of 3 callbacks per batch" are written down once and available in every future conversation.

**3. prompt_context.py** is a UserPromptSubmit hook that runs on every message. It scans the prompt for keywords, matches them against a rules file (`memory-rules.json`), and injects relevant documentation into the conversation. The word "tax" matches the `tax-avalara` rule, which loads `AVALARA-API-GUIDE.md` and the critical rules for that area. The word "bridge" loads the Python 2.7 bridge technical reference and pairing mechanism docs.

The keyword matching includes fuzzy matching for typos (edit distance ~1 for words longer than 4 characters) and alias support ("py27", "py2", "python2" all trigger the bridge rules).

17 rules cover: bridge/connector, deployment, email, ERP sync, product data, connector publishing, Cloudflare caching, the ERP sessions, dashboard UI, RF scaling, versioning, the ERP REST API, product architecture, tracking/shipping, tax/the tax engine, connector architecture, and bridge guide.

**4. Agents** are dispatched when Claude needs live project state. A code-agent reads source files. A data-agent runs SQL queries. A build-agent executes implementation plans. A review-agent audits changes. A git-agent handles version control. Each is a specialized subprocess with its own prompt defining scope and constraints.

23 agent definitions cover both the engineering workflow (code, data, plan, build, review, git) and operational tasks (the PM tool, email campaigns, design requests, deployment).

**5. Skills** are repeatable audit commands triggered by keyword or explicitly. The skill-rules system maps prompts to checks:

- `/static-analysis` -- triggered when editing API routes, auth code, or anything with SQL. Scans for injection, missing auth decorators, unsafe patterns.
- `/insecure-defaults` -- triggered when editing config or error handling. Looks for `.get(key, False)` patterns that fail open, bare `except` blocks, missing validation.
- `/sharp-edges` -- triggered when editing the Python 2.7 bridge. Checks for `basestring` vs `str`, callback batch limits, CRC validation.
- `/review` -- full pre-deploy audit combining all checks.

The skill system has three modes: Suggest (recommend running it), Warn (flag but don't block), and Block (prevent the message from processing until the skill is run).

**6. PostToolUse hooks** run after every file edit. Two things happen automatically:

- **Ruff** checks every Python file for undefined names (`F821`) and redefined names (`F811`). Issues are caught at the moment of creation, not at commit time.
- **Security path flagging** warns when editing files in `api/`, `connector/`, or deployment scripts. The warning reminds to run `/static-analysis` before committing.

Additionally, the hook tracks context window usage by estimating tokens from the session log. At ~60% estimated capacity, it warns to start wrapping up. At ~80%, it recommends committing and handing off. MEMORY.md edits are guarded with a line-count check (warning at 120 lines, hard limit at 170).

## The Agent Pipeline

For non-trivial changes, agents coordinate through a standard sequence:

```text
GATHER     code-agent + data-agent read relevant files and state (parallel)
PLAN       plan-agent produces a structured implementation plan
REVIEW     plan-reviewer validates the plan, deep-reviewers check specifics
APPROVE    plan shown for approval before any code is written
EXECUTE    build-agent implements step-by-step, one file at a time
COMMIT     git-agent stages, commits, and verifies
```

The plan-reviewer checks for scope creep, missing edge cases, and architectural consistency. Two deep-reviewers (Python-specific and database-specific) run security and correctness checks on the plan before execution starts.

Non-trivial changes go through the full sequence. The build-agent executes the approved plan -- it doesn't improvise.

## Memory Architecture

Memory is split into two tiers:

**Always loaded** -- `CLAUDE.md` (project architecture, <120 lines) and `MEMORY.md` (topic index, <120 lines). These are in every conversation regardless of topic.

**On demand** -- Topic files loaded by the hook when keywords match. Each topic file covers one area: bridge technical details, deployment patterns, email infrastructure, product architecture, etc. A conversation about tax reconciliation loads the tax engine guide. A conversation about the connector loads the bridge reference. Conversations that don't touch those areas don't pay the context cost.

New lessons are written to topic files as they're discovered. The memory system grows over time without growing the always-loaded context.

## Configuration Layers

The system uses three configuration layers that cascade:

| Layer | Scope | What It Contains |
|-------|-------|-----------------|
| Global (`~/.claude/`) | All projects | Base permissions, auto-rename hook, effort level |
| Orchestrator (Task Management `.claude/`) | Work projects | Agent definitions, intent recognition, workflow docs |
| Project (per-project `.claude/`) | Single project | CLAUDE.md, hooks, memory rules, skill rules, settings |

Each layer extends the one above. The global layer sets defaults. The orchestrator layer defines agents that work across projects. The project layer has domain-specific hooks and rules.

