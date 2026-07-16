# Read-Only SQL Enforced at Two Layers for Agent Tools

**Status:** Accepted | **Date:** 2026-04-17 | **Theme:** security

## Context

The AI-agent tool layer exposes a raw SQL query tool so agents can run exploratory queries against the application database. Ad-hoc SQL is among the highest-value agent capabilities, but a single mistaken or manipulated query could mutate data if left unguarded. A guard that lives in only one layer can be defeated by a buggy client or a crafted prompt.

## Decision

Read-only enforcement runs at two independent layers. The client-side tool guard rejects mutation SQL through forbidden-keyword screening and auto-applies a LIMIT to every query. Underneath it, the PostgreSQL session runs with default_transaction_read_only set on, so a bypassed or buggy client guard still cannot write. This has been in place since the first PostgreSQL backend in April 2026; a later security audit confirmed the three defenses working together: keyword rejection, LIMIT, and the session flag.

## Alternatives Considered

Client-side checks alone did not fit this context because keyword and regex guards are bypassable, and a single layer leaves no backstop when the guard has a gap or a new mutation form slips past the keyword list. Removing the raw SQL tool entirely did not fit either: exploratory queries answer questions that curated, purpose-built tools cannot anticipate, and dropping the capability would trade away the agent layer's most useful read power to avoid a risk the second layer already contains.

## Consequences

Agents get broad read access with a bounded blast radius. The session-level read-only flag is the backstop that holds even when the client guard does not, a belt-and-suspenders arrangement rather than a single point of trust. Write capability is deliberately excluded from this path; any write requires an entirely separate, individually gated tool. The cost is that legitimate write workflows cannot reuse the raw SQL surface and must be built as explicit tools, which is the intended boundary rather than a limitation to work around.
