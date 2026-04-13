# ADR-029: Custom Element `<cn-shell>` for Consistent Dashboard Chrome
## Context

56 dashboard pages all need the same chrome: a collapsible left sidebar with category-grouped navigation, a header with user info and environment badge, a feedback button, a system-tray-style indicator for the ERP seat status, and a mobile menu. Without framework components, the options for sharing this UI across pages are limited:

1. **Server-side templating** -- Flask renders each page with a shared layout template. Would work but means every HTML file becomes a Jinja template, and editing a page requires understanding the template hierarchy. Not aligned with the "each page is a standalone file" decision from ADR-028.
2. **Copy-paste the chrome into every HTML file.** 56 copies of the same sidebar, 56 copies of the same header. Every chrome change becomes a 56-file edit. Rejected immediately.
3. **JavaScript `initChrome()` called from each page.** Causes chrome flicker on load -- the page loads, then JavaScript runs, then the chrome appears.
4. **Native Web Components** -- define `<cn-shell>` once as a Custom Element, then every page declares `<cn-shell page="x">...</cn-shell>` and the element handles setup internally. No flicker because the element is in the DOM from parse time, and the chrome logic is encapsulated in one file.

## Decision

**Build `<cn-shell>` as a native Custom Element** (`dashboard/js/components/cn-shell.js`, 1,037 lines). Every protected page wraps its main content in `<cn-shell page="page-id">...</cn-shell>`. The element:

- Renders the collapsible left sidebar from `nav-config.js`, filtered by the current user's `page_access` permissions.
- Renders the header with environment badge (DEV / STAGING / hidden in production), user info, the ERP seat status, and feedback button.
- Handles mobile menu toggle.
- Fires a `cn-shell-ready` custom event when DOM construction is complete, so page init scripts can gate on it and avoid race conditions.
- Persists sidebar collapsed state in `localStorage`.
- Calls `/api/auth/me` once per page load and caches the result on `window._nexusAuthPromise` so both `cn-shell` and `page-guard.js` share a single request.

Adding a new page to the sidebar is a two-line change in `nav-config.js`. The shell handles environment detection centrally. Every page gets the feedback panel (`<cn-feedback>`) and the passive diagnostic layer automatically.

## Alternatives Considered

- **React/Vue layout component.** Would work but requires adopting the framework. Rejected per ADR-028.
- **Server-side Jinja layout template.** Would work but moves chrome logic to the server. Rejected because it breaks the "each page is a standalone HTML file" model and the static-file deployment simplicity.
- **JavaScript `initChrome()` called from each page.** Causes chrome flicker on load. Rejected.
- **Iframe containing the shell, with page content rendered inside.** Would solve the chrome-sharing problem but breaks URL handling, deep linking, auth, and scrolling. Considered and immediately rejected.

## Consequences

**Good:**
- Every page gets consistent chrome with zero per-page effort. Adding a new page is: write the HTML, wrap it in `<cn-shell page="new-page">`, add a line to `nav-config.js`, done.
- Chrome changes propagate automatically. One file change updates every page.
- The `cn-shell-ready` event gives page scripts a clean synchronization point. Pages don't have to guess when navigation is rendered.
- The shell is testable in isolation. Mount it with a known navigation config, verify the DOM it produces, verify the events it fires.
- Encapsulation via custom elements means the shell's implementation details don't leak into page code.

**Bad / costs:**
- `cn-shell.js` is 1,037 lines. It does a lot because it handles a lot. The file has grown over time as features have been added. Keeping it coherent requires care.
- Custom Elements have a learning curve. Anyone new to the codebase needs to understand how the element lifecycle works (connectedCallback, attributeChangedCallback).
- The shell is a single point of failure for the whole dashboard. A bug in `cn-shell.js` could break every page simultaneously. Mitigated by keeping the shell's logic bounded (auth + nav + header only) and by thorough testing before every deploy.
- Not using shadow DOM means the shell renders into light DOM. This makes DevTools inspection easy but removes style encapsulation.

## Related decisions

- [ADR-028: Vanilla JavaScript with ES modules over a framework](028-vanilla-js-es-modules-over-framework.md) -- the shell is how the framework-less approach stays maintainable at 56 pages.
- [ADR-030: Passive diagnostic capture](030-passive-diagnostic-capture.md) -- bug capture mounts inside `cn-shell`, so every page gets it automatically.