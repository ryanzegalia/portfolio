# Nexus Dashboard -- UI Architecture

> 56 HTML pages, 31 JavaScript modules, ~22,000 lines of CSS across a custom design system. Built without a framework, bundler, or build step. This document covers the architectural choices that made a framework-free approach viable for 56 pages.

## Summary

The Nexus operations dashboard is a **multi-page application** built entirely in **vanilla JavaScript with ES modules**, served as static HTML files by Flask, with a custom CSS design system based on CSS custom properties. Every page is a standalone file that can be read in isolation. Shared chrome comes from a native Web Component (`<cn-shell>`, 1,037 lines). The design token layer (375 lines in `tokens.css`) is read at runtime by both CSS and Chart.js so visual consistency is automatic. Three pages use Server-Sent Events for real-time progress on long-running backend operations. Authentication is dual-layer (session cookies server-side, company portal short-lived tokens for external APIs). Bug reports carry automatic diagnostic context captured passively by a 460-line client-side recorder.

## The page-level architecture

**Each page is one HTML file.** No server-side templating of page content (Flask serves the files as static assets). No build step that compiles JSX or Svelte into HTML. Every page loads its JavaScript via `<script type="module">` directly from `dashboard/js/`. The browser parses the page, the ES module imports resolve, and the page bootstraps itself.

This means every page is readable in isolation. Open `product.html` (5,603 lines -- the flagship page) and you can trace every behavior without hopping between a component tree, a template file, and a state store. It's denser than a typical framework codebase at the individual file level, but more legible at the system level -- every behavior is traceable in the file that owns it.

**The 56 pages** cover the full operational surface: product catalog editing (7 pages), pricing workflows (6), order/shipping operations (8), tax reconciliation (1), QC workflows (4), event management (4), email marketing (2), connector/hardware (7), and admin/system (17). Every page that requires authentication wraps its content in `<cn-shell page="page-id">` and calls `page-guard.js` for access control.

## The shell component (`<cn-shell>`)

`dashboard/js/components/cn-shell.js` -- 1,037 lines -- is the most important single file in the dashboard UI layer. It's a **native Custom Element** (no framework, no library) that every page uses. When a page declares `<cn-shell page="sales">`, the shell takes over rendering the sidebar navigation, the header (with environment badge, user info, ERP seat status, feedback button), the mobile menu, and mounts the feedback panel.

Key behaviors:

- **Reads `nav-config.js`** for the sidebar category structure, then filters items by the current user's `page_access` permissions. Adding a new page to the sidebar is a two-line change in one file.
- **Calls `/api/auth/me` once per page load** and caches the result on `window._nexusAuthPromise` so `page-guard.js` and the shell's own header rendering don't both make the same request.
- **Persists sidebar collapsed state to `localStorage`.**
- **Shows the environment badge** (DEV / STAGING / hidden in production) automatically based on config.
- **Fires a `cn-shell-ready` event** when DOM construction is complete, so page init scripts can gate on it to avoid race conditions with the shell's own rendering.

The shell is also the mount point for `<cn-feedback>` (the feedback slide-out) and the bug-capture diagnostic layer, so every page gets those features for free without opting in.

See [ADR-029: Custom Element `<cn-shell>` for consistent dashboard chrome](../decisions/029-custom-element-shell-for-consistent-chrome.md) for the full reasoning.

## JavaScript architecture

### Shared infrastructure modules (10 files)

| File | Lines | Role |
|---|---|---|
| `data.js` | 1,745 | Shared data layer. Every page imports named functions (`getProducts`, `getStats`, `getSKUs`) rather than calling `fetch` directly. `fetchJSON()` handles 401 redirect universally. |
| `auth.js` | 372 | Company portal OAuth via popup + `postMessage`. JWT decode. Token refresh. `fetchWithAuth()` for external API calls. |
| `page-guard.js` | 153 | Per-page access check via `/api/auth/me`. Redirects unauthenticated users. Sends pageview analytics via `sendBeacon`. `initWhenReady()` helper for race-condition-safe page init. |
| `config.js` | 110 | Centralized config loaded from `/api/v1/config` at startup. Exports `CONFIG`, `isFeatureEnabled()`, environment helpers. |
| `nav-config.js` | 44 | Single source of truth for sidebar categories and page membership. |
| `page-display.js` | 179 | Page metadata (icons, descriptions) mirrored from server-side `api/pages.py`. |
| `date-utils.js` | 179 | UTC timestamp parsing + locale-aware formatting. Handles SQLite bare timestamps (legacy). |
| `chart-theme.js` | 236 | Chart.js global defaults read from CSS tokens at runtime. Themes every chart on every page automatically. |
| `debug.js` | 187 | Global `window.CS_DEBUG` logger with rolling buffer. Patches `fetch` to log all requests. |
| `api.js` | 8 | Minimal REST helper for one specific page. Kept for backward compatibility. |

### Shared UI components (5 Custom Elements)

| File | Lines | Role |
|---|---|---|
| `components/cn-shell.js` | 1,037 | The dashboard shell. Covered above. |
| `components/cn-feedback.js` | 1,118 | Feedback slide-out panel. Three flows: bug / enhancement / new idea. Mounts inside cn-shell. |
| `components/cn-feedback-annotator.js` | 637 | Canvas-based screenshot annotation. In-browser drawing, zero external libraries. |
| `components/cn-product-picker.js` | 1,122 | Product search/filter modal. Used by kits.html, linking.html, quote.html. |
| `components/cn-product-card.js` | 110 | Small card component used inside `cn-product-picker`. |

### The diagnostic layer

`bug-capture.js` (460 lines) is a key diagnostic component. It loads via `cn-shell` on every page and captures:

- Console output (patches `console.log/warn/error/info`, 50-entry rolling buffer)
- Uncaught errors (`window.onerror`, `unhandledrejection`)
- Interaction breadcrumbs (clicks, keys, scroll, focus, navigation -- last 100)
- Overlay/modal events (via `MutationObserver` watching for `aria-modal="true"` or `.modal-*` classes)
- Network history (reads from `CS_DEBUG.logs`, last 30 requests)
- Viewport + connection info

When the user clicks the feedback button, all of this context is attached to the bug report automatically. The user writes one sentence; the system captures hundreds of data points. See [ADR-030: Passive diagnostic capture](../decisions/030-passive-diagnostic-capture.md).

### Page-specific glue modules (15+ files)

Each page that has substantial per-page logic has its own JS module. Examples: `tax-recon.js` (3,835 lines -- the largest JS file in the system, powering the tax reconciliation page's three-way diff and Excel export), `quote-builder.js` (1,019 lines), `review-portal.js` (729 lines), `testing.js` (721 lines), `event-signage.js` (849 lines), `event-detail.js` (623 lines).

## CSS architecture

### Three layers

`dashboard/css/` contains three CSS files loaded in order on every page:

1. **`tokens.css`** (375 lines) -- CSS custom properties for every visual value. Colors, typography, spacing, shadows, border radii, animation durations, z-index layers. Single source of truth.
2. **`base.css`** -- opinionated reset (box-sizing, margin/padding zero, text rendering optimization), plus body defaults wired to tokens.
3. **`components.css`** -- cards, stat-cards, buttons, badges, tables, forms, modals. BEM-adjacent naming, no utility classes.

Plus per-page stylesheets in `dashboard/css/pages/*.css` for page-specific layout.

### Token categories

| Category | Examples |
|---|---|
| Neutral grays | `--gray-50` through `--gray-950` (11 stops) |
| Semantic surfaces | `--bg-page`, `--bg-card`, `--bg-elevated`, `--bg-hover`, `--bg-input` |
| Text hierarchy | `--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-muted`, `--text-disabled` |
| Domain-specific | `--color-in-stock`, `--color-low-stock`, `--color-out-of-stock`, `--color-backordered` |
| Accent | `--color-accent` (#2563EB), `--color-accent-hover`, `--color-accent-muted` |
| Feedback | `--color-success`, `--color-warning`, `--color-error`, `--color-info` |
| Status badges | Per-state color tokens for workflow statuses |
| Chart palette | `--chart-1` through `--chart-6` |
| Typography | Inter (sans), JetBrains Mono (mono), 8 size steps, weights, line heights |
| Spacing | 4px base unit, 0-24 scale |
| Borders + shadows | Radii, shadow levels, focus ring |
| Animation | Durations, easing curves, reduced-motion override |

### Light mode only

`tokens.css` is light-mode only. The token architecture supports theming -- adding a `:root[data-theme="dark"]` override block would flip the entire UI -- but dark-mode values haven't been defined. The `design-system/styleguide.html` demo page is the one intended place where `data-theme="dark"` appears.

See [ADR-031: CSS custom properties as the single design token source](../decisions/031-css-custom-properties-single-design-token-source.md).

## Real-time features

Three pages use **Server-Sent Events** (`EventSource`) for long-running backend operations:

- `sales.html` -- sale activation/deactivation progress (per-option updates as the pricing engine applies changes)
- `price-increase.html` -- bulk price update progress
- `firmware.html` -- device flashing progress (from the Connector)

SSE was chosen over WebSockets because the traffic is one-directional (server -> client) and Flask generators yield progress events naturally. No WebSocket library, no special proxy configuration, no bidirectional state machine. See [ADR-016: SSE + POST dual-path with fallback signal](../decisions/016-sse-post-dual-path.md).

## Authentication model

**Two layers:**

1. **Session cookies, server-side** -- the authoritative auth. `/api/auth/me` returns the current user based on the `auth_sessions` table. Every protected route checks this.
2. **Company portal short-lived tokens** -- used only for calls to the company portal API (an external service). Not required for the dashboard's own API.

The two layers are deliberately separate. A Redis outage doesn't affect sessions (they're in Postgres, not Redis). A Portal outage doesn't log users out (they're still authenticated against Nexus's own session store).

Login flow: user clicks "Sign in with Company Portal" -> popup opens portal OAuth -> portal posts JWT via `window.postMessage` -> popup closes -> `auth.js` stores short-lived tokens AND calls `/api/auth/login` to create a server-side session -> reload page.

A gated operational fallback exists for identity-provider outages.

## Pageview analytics

Every successful `checkPageAccess` call fires a `navigator.sendBeacon` to `/api/v1/analytics/event` with `{event_type: 'pageview', page, referrer}`. Transparent to page code -- it's inside the guard, not something each page has to call. `sendBeacon` is fire-and-forget and doesn't block page navigation.

## Related documentation

- [ADR-028: Vanilla JavaScript with ES modules over a framework](../decisions/028-vanilla-js-es-modules-over-framework.md)
- [ADR-029: Custom Element `<cn-shell>` for consistent chrome](../decisions/029-custom-element-shell-for-consistent-chrome.md)
- [ADR-030: Passive diagnostic capture](../decisions/030-passive-diagnostic-capture.md)
- [ADR-031: CSS custom properties as the single design token source](../decisions/031-css-custom-properties-single-design-token-source.md)