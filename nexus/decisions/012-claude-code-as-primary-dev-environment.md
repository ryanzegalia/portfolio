# ADR-012: Claude Code as the Primary Development Environment
## Context

The question was not whether to use AI coding tools but how to use them as the primary development surface, not as autocomplete on the side. Most AI-assisted workflows add a suggestion layer inside an existing IDE. The result is incremental: the AI helps with boilerplate, but the developer is still doing most of the architecture, debugging, and iteration manually.

The experiment was to invert the model: use AI as the execution layer and keep architecture and judgment with the developer.

## Decision

**Claude Code is the primary development environment for Nexus.** The workflow:

1. Define what needs to be built in terms of outcomes (a new heartbeat for vendor cost sync, a smart column resolver for tax reconciliation, a circuit breaker layer for external APIs).
2. Architect the solution -- data model, service boundaries, failure modes, testing strategy -- at a high level.
3. Claude Code writes the code, runs tests, investigates failures, proposes next steps.
4. Review the output, correct architectural drift, reject anything that does not match existing patterns, and approve changes for commit.

Part of the decision is not just "use Claude Code" -- it is "invest time in structuring the project so Claude Code is maximally effective inside it." The project has a `.claude/` folder with agent definitions, a CLAUDE.md orchestrator, and plan files that document decisions. That scaffolding is what makes the workflow scale.

Context discipline is central. Moving content from always-loaded to on-demand is the core optimization. A rule in an 800-line configuration file competes with 800 lines of other rules. A hook fires at exactly the moment it is relevant and injects one specific reminder into the live context. The project continuously tunes this.

## Alternatives Considered

- **Traditional development with AI as a suggestion layer.** Full control over every keystroke but significantly lower velocity. Some features would not have been built at all given time constraints.

- **Hire a contractor to implement each feature.** Faster per-feature but loses continuity. A contractor does not know the patterns that emerged over months of building -- the circuit breaker style, the per-service migration pattern, the sync_changelog convention. Every feature would look different.

- **Use Copilot inside VS Code.** Effective at token-level suggestions but does not do multi-file refactors, cross-service consistency checks, or architectural reasoning. For work that requires consistent patterns across many services, a fuller agentic workflow is a better fit.

## Consequences

**Good:**
- Architectural patterns (circuit breakers, per-entity locks, SSE+POST, idempotent migrations) are implemented consistently across services. The agentic workflow applies patterns uniformly when given the right context.
- The plan-file discipline emerged naturally. Every nontrivial change starts with a plan file documenting the problem, approach, alternatives, and consequences. The plans serve as the primary source for this entire ADR set.
- Development velocity is higher for pattern-consistent changes across many services.

**Bad / costs:**
- Knowledge transfer to a successor requires learning both the codebase and the workflow that produces it. The latter is harder to hand off.
- Context discipline is a real cost. Structuring the project so every session starts with the right context (and not too much context) is ongoing maintenance work.
- The workflow is not stable. Claude Code changes frequently. Agent definitions change. Skill conventions change. The project has to keep up or the workflow degrades.
- The workflow is AI-dependent for new development. The codebase itself runs independently (Python on a production VPS -- no AI dependencies at runtime), but feature velocity would decrease if the tooling changed significantly.
