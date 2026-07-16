# ADR-030: Passive Diagnostic Capture for Zero-Friction Bug Reporting
## Context

Operators reporting bugs in an internal tool face a universal problem: by the time they think to file a report, the context of what went wrong is already gone. The console message that explained the error has scrolled off. The sequence of clicks that led to the problem is forgotten. The network request that failed is buried in DevTools they never opened.

The standard solutions -- "open the browser console and copy the error," "screenshot DevTools," "write down exactly what you did" -- all depend on the user doing extra work at the moment when they're already frustrated. It doesn't happen. What happens instead is "something broke" as the bug report, which is not actionable.

The better model: capture everything passively while the user works. When they click the feedback button, the context is already there.

## Decision

**Load `bug-capture.js` on every dashboard page via `<cn-shell>`.** The module intercepts and records the following, with a rolling buffer so old data is evicted but recent data is always available:

1. **Console output** -- patches `console.log`, `console.warn`, `console.error`, `console.info` to capture every message to a 50-entry rolling buffer. The original console functions still fire with no user-visible change.
2. **Uncaught errors** -- listens for `window.onerror` and `unhandledrejection` events.
3. **Interaction breadcrumbs** -- tracks clicks, keyboard events, scroll, focus, and navigation as a chronological trail. Last 100 interactions retained.
4. **Overlay / modal events** -- `MutationObserver` watches for DOM elements with `aria-modal="true"` or class names matching `.modal-*` patterns, records when they appear and disappear.
5. **Network history** -- reads from `CS_DEBUG.logs` (a debug helper that patches `fetch` and `XMLHttpRequest` to log requests). Last 30 requests with URL, method, status, duration.
6. **Viewport + connection info** -- window size, device pixel ratio, online/offline status, connection type if available.

When the user clicks the feedback button in `<cn-shell>`, a slide-out panel opens. The user describes the problem in plain text and optionally annotates a screenshot. On submit, `bug-capture.getSnapshot()` returns the full diagnostic context, which is sent to the Nexus API as a single feedback record alongside the user description and any screenshot.

The user wrote one sentence. The system captured hundreds of data points of context.

## Alternatives Considered

- **Tell users to copy the console output manually.** What most tools ask. Fails because users don't do it.
- **Use a third-party feedback widget** (Sentry's user feedback, LogRocket, Fullstory). Work well but introduce an external dependency with its own privacy surface and cost. For an internal tool with no external users, a custom solution is lighter.
- **Full session replay via a service like LogRocket.** Broader still, but records every click and keystroke continuously -- raises privacy concerns even for internal tools, and has ongoing cost. The passive-until-submit pattern captures enough without recording the full session.
- **Server-side error logging only.** Already exists (loguru, api_health_log). But server-side logs don't have client-side context -- which button was clicked, what modal was open, what the browser state looked like. Client-side capture closes that gap.

## Consequences

**Good:**
- Bug reports become actionable. "The shipping page broke" becomes "the shipping page broke after clicking X while Y was loading, here's the console error, here's the network request that 500'd." Same user effort, orders-of-magnitude better information.
- Zero friction. Users don't have to remember to enable anything, open DevTools, or do any prep work. Every page has the context available by default.
- `bug-capture.js` is 460 lines with zero runtime cost beyond the console/event listener wrapping. No network traffic until feedback is actually submitted.
- Debugging complex operator reports is dramatically faster. Issues that would take 30 minutes of back-and-forth under the old "screenshot + description" model are traceable in seconds.

**Bad / costs:**
- Privacy concern: the capture records everything on the page, including input values and visible data. For an internal tool with authenticated employees, this is acceptable, but it would not be for a customer-facing product.
- The 50-entry console buffer and 100-entry interaction buffer are bounded but not tuned. An operator who encounters a bug after hours of work might have the relevant state already evicted.
- `MutationObserver` on the full document fires for every DOM mutation. Mitigated by filtering to specific node types inside the observer callback, but the observer is still watching everything.
- The network history depends on `CS_DEBUG.logs` being enabled. If that module is disabled to clean up console noise, network capture stops working. Documented in the file header but a fragile dependency.

## Related decisions

- [ADR-029: Custom Element `<cn-shell>`](029-custom-element-shell-for-consistent-chrome.md) -- bug capture loads inside the shell, so every page gets it automatically without opting in.
- [ADR-020: sync_changelog as cross-cutting activity feed](020-sync-changelog-as-cross-cutting-activity-feed.md) -- same design principle at a different layer: cheap, always-on passive capture that becomes valuable when something goes wrong.