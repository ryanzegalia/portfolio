# ADR-028: Vanilla JavaScript with ES Modules Over a Framework
## Context

Every modern dashboard defaults to React, Vue, Svelte, or Angular. A framework brings component reuse, state management, virtual DOM, hot reload, tooling, and a large ecosystem. Starting a new dashboard without one is unusual enough that it needs to be a conscious decision.

The Nexus dashboard has 56 pages, 31 JS modules totaling ~18K lines, and handles the full operational surface of a hardware manufacturer -- product management, pricing workflows, QC tracking, shipping, tax reconciliation, event management, firmware operations. The dashboard is not small. Using a framework would be defensible. Going without one requires justification.

## Decision

**Vanilla JavaScript with ES modules loaded directly in the browser via `<script type="module">`. No framework, no bundler, no build step.** Each of the 56 pages is a standalone HTML file. Shared logic lives in `dashboard/js/` as ES modules that pages import directly. Custom elements (native Web Components) handle the shell, feedback panel, product picker, and product card components.

Key factors in this choice:

- **The dashboard is an internal tool, not a consumer-facing web app.** Operators are authenticated employees. No SEO requirements, no accessibility regulations beyond basic ARIA, no mobile optimization beyond the tablet form factor. The requirements a framework solves are mostly absent.
- **The interactivity level is moderate.** Pages fetch data from `/api/v1/*`, render it, handle a few buttons and forms, and maybe stream progress via SSE. React-level reactivity is not required. `document.querySelector` + `innerHTML` + event listeners handles everything.
- **The development team is small.** A framework's component ecosystem pays off when multiple developers need to share code. At Nexus's scale, code legibility matters more than componentization.
- **Claude Code is the primary development tool.** AI works best against readable text. A 5,603-line `product.html` that contains all of its logic inline is more legible to Claude Code than a React tree split across 40 `.jsx` files. Picking a framework would have made the AI workflow harder, not easier.

## Alternatives Considered

- **React.** The default. Rejected because the benefits (componentization, virtual DOM, state management) don't apply strongly at Nexus's scale and form factor. The costs (build tooling, version upgrades, hydration bugs, ecosystem churn) are real.

- **Vue 3.** Similar profile to React, slightly lighter footprint. Same analysis -- the pros don't apply at Nexus's scale.

- **Svelte.** Compiles away at build time, which makes the runtime small. But still requires a build step, and avoiding the build step was a core goal. The "edit file, reload browser" iteration cycle has been worth more than any framework feature.

- **HTMX.** Server-rendered HTML with AJAX sprinkles. Considered as an alternative to ES modules. Rejected because it shifts complexity to the server (route handlers rendering partial HTML instead of returning JSON). Nexus's JSON API is already established and the clean separation between API and dashboard is valuable.

- **Alpine.js.** Declarative attributes on HTML elements. A lighter-weight alternative to a full framework. Considered and partially adopted -- some pages use Alpine-style patterns without actually importing Alpine. The full library wasn't needed.

## Consequences

**Good:**
- Zero build time. Save file, reload browser, working page. No webpack watch mode, no HMR server, no compilation wait. The iteration cycle is as fast as it gets.
- Zero dependency upgrade burden. There's no `package.json` in the dashboard. Nothing to patch when the next Node LTS drops, nothing to `npm audit`, nothing to migrate when a major framework version ships.
- Every page is a standalone HTML file readable in isolation. Open `product.html`, read the `<script type="module">` section, follow the imports -- the entire page behavior is visible in a bounded set of files.
- Claude Code sees clean text files with clear structure. When adding a new feature to `product.html`, the change can be made directly against the file, verified in the browser, and committed. No build pipeline involved.
- The 5,603-line `product.html` is an intentional design choice. Every tab of the product detail editor is visible in one file, and searching for anything finds it immediately.

**Bad / costs:**
- No component reuse the way frameworks enable it. Shared UI (modals, tables, form fields) is either duplicated across pages or lifted into a Custom Element. Some duplication exists.
- No TypeScript. Type errors surface at runtime instead of at build time. Mitigated by keeping functions small and writing explicit JSDoc comments for key types. The cost is real but manageable.
- No routing library. Each HTML file IS a route. Navigation between pages is full page loads (though the `<cn-shell>` handles this transparently so it feels like a single-page app).
- No state management library. State lives in `sessionStorage`, `localStorage`, and per-page JavaScript closures. For Nexus's requirements this is fine; for a more complex client-side state model it wouldn't be.
- The pattern is unusual enough that new developers would need onboarding specifically for "why is this not React?" That explanation cost is real and recurs at every new contributor or code review conversation.

## Related decisions

- [ADR-029: Custom Element `<cn-shell>` for consistent chrome](029-custom-element-shell-for-consistent-chrome.md) -- the shell component is how the "no framework" decision manages cross-page consistency without component libraries.
- [ADR-031: CSS custom properties as the single design token source](031-css-custom-properties-single-design-token-source.md) -- same principle: use the native platform feature when it's sufficient.