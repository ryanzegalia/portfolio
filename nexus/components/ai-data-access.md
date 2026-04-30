# Conversational Data Access (Internal MCP Server)
> Part of the Nexus production automation platform

An internal MCP server that exposes the platform's data and operational surface as ~88 callable tools. Internal users — and the dev environment itself — issue natural-language questions and get answers grounded in live (or near-live) data, instead of writing SQL or clicking through admin UIs.


## What it is

A 1,675-line Python MCP server fronting the platform's own data warehouse plus three connected third-party systems (a helpdesk, a marketing-automation platform, and a vendor data feed). ~88 tools registered, organized into ~37 module files grouped by business domain.

| Domain | What's in it |
|---|---|
| Customer | 360-degree view, contact history, identity reconciliation |
| Order | order detail, delivery digests, shipping lookup |
| Support | tickets, support analytics, contact history |
| Email | campaign planner, scheduler, event inspection |
| Identity | account / email / contact stitching across systems |
| Operations | day / week / month rollups, top-N analyses |

Plus two MCP **resources** -- a domain glossary and a knowledge-base index -- registered separately from tools, so the agent can look up definitions and topic listings without spending a tool call on the lookup.


## Why it exists

Ad-hoc data questions used to be a SQL editor + spreadsheet round-trip: write the query, export, paste into a sheet, summarize. Multiply that by the dozens of "how many X this week", "what's our top Y", "did this customer ever Z" questions that come up across a working day, and the cost is real. The MCP server collapses that round-trip to a sentence.


## Three environment modes <a id="environments"></a>

The same tool surface runs against three environments, switched via a single env var:

| Mode | Connects to | When |
|---|---|---|
| `dev` | localhost | Tool development; never touches shared state. |
| `staging` | LAN to a daily-snapshot replica of prod | Default. Dangerous queries stay off prod. |
| `prod` | SSH-tunneled to the remote production host | Only when the answer needs current-day data. |

Staging being the default is intentional. Most analytical questions are tolerant of yesterday's snapshot, and any mutation tool (a tool that writes data, as opposed to a query tool that only reads) that fires accidentally hits the snapshot, not the live database. Prod mode is opt-in per session.


## Read-only by default <a id="safety"></a>

The general SQL query tool is locked down at multiple layers:

1. The tool only accepts parameterized SQL -- bound parameters, no string concatenation.
2. The connecting database role has no write grants on production tables. Even if a query gets through the application layer, the database refuses it.
3. A prepared-statement validation step rejects anything that parses to a non-SELECT.

Mutation tools -- updating planner fields, linking records to project-management items, tagging campaigns, etc. -- live in a separate, explicitly-named tool family. A "query" call cannot accidentally write; the operations are namespaced separately so the agent (and the user) always know which mode they're in.


## OAuth wrapper for a non-API system

One of the connected third-party systems doesn't expose stable read APIs. Rather than ask the agent to drive a browser session per call, the MCP server holds the OAuth flow and refreshes tokens behind the scenes. Tools on that domain look like every other tool -- the auth complexity stays inside the server.


## What it answers

A non-exhaustive sample of the question shapes the layer is built for:

- Daily / weekly / monthly order and revenue rollups
- Top-moving SKUs by units, revenue, or margin
- Support ticket trends -- volume, category, escalation
- Per-customer history across orders, support, and marketing engagement
- Identity reconciliation when the same person appears under multiple emails
- Campaign engagement: opens, clicks, conversions, lapsed-list candidates


## Cross-cutting patterns

Every domain module exposes the same shape: a small handful of read tools, a small handful of mutation tools (only where mutation is part of the workflow), and one or two summary tools that pre-aggregate common rollups. Tools don't reach across domains directly -- when a customer-domain answer needs order data, it calls the order-domain tool. The boundary keeps each module independently testable and keeps the prompt-side tool surface coherent.
