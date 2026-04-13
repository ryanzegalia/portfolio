# The Bethl'mite

Event management system for a monthly print postcard listing local concerts, art openings, and events in Bethlehem, PA.

> This directory is a source excerpt from the working repo. The full codebase is private; I can share access during an interview on request.

| | |
|---|---|
| **Stack** | Node.js/Express, React 18, SQLite (sql.js), Vite |
| **Lines** | ~34,000 |
| **Auth** | Google OAuth + email/password + invite tokens |
| **Roles** | Crew (editorial), Venue (event submission), Distributor (card pickup) |

## What It Does

The Bethl'mite is a free monthly postcard that lists upcoming events. Venues submit events, a small crew curates and builds each issue, print runs are tracked through ordering and delivery, and distributors request cards for their locations.

The system manages the full lifecycle: event submission and approval, issue assembly with drag-and-drop ordering, print run tracking with partial shipment support, and distribution inventory management.

## Architecture

```text
Venues submit events (pending) ──→ Crew approves/rejects
                                        │
                              Crew builds issue (planning)
                              ├── Drag-and-drop event ordering
                              ├── Quick-assign from approved pool
                              └── Art submission review
                                        │
                              Finalize (content locks) ──→ Print run ordered
                                                                │
                                                    Mark received (partial shipments)
                                                                │
                                                    Distributed ──→ Issue closed
```

Three portals serve different roles:
- **Crew** -- Issue builder, event moderation, analytics, user management
- **Venue** -- Event submission, status tracking, venue profile
- **Distributor** -- Card request system, pickup locations

## Key Decisions

**Atomic SQLite writes.** The database layer wraps sql.js with a write pattern that prevents corruption: serialize to buffer, write to temp file, fsync, then atomic rename over the live database. Auto-save runs every 30 seconds on a non-blocking timer (`process.unref()`). A live backup copy is written on each save for recovery. The migration system detects schema changes at startup and applies them in sequence -- soft-delete columns, content locking timestamps, print run tables, analytics aggregation.

**Issue lifecycle state machine.** Issues move through planning, finalized, printed, and distributed states with validation guards at each transition. Finalizing an issue sets `content_locked_at`, which prevents any event modifications -- events in non-planning issues can't be edited, reordered, or removed. Moving to "printed" requires recording receipt from the printer. Closing an issue force-transitions to "distributed" with a write-off reason if cards remain undelivered.

**Print run inventory with additive tracking.** Print shipments often arrive in batches. The system distinguishes between `quantity_received_add` (additive, for marking a partial shipment as received) and `quantity_received` (replacement, for correcting a count). Demand signals compare pending card requests against remaining inventory to surface shortfalls. Print run deletion is blocked if cards have already been received, preventing inventory corruption.

**Multi-pathway authentication.** Users can sign up via Google OAuth, traditional email/password, or invite token. Invite-based onboarding lets crew send a link to a venue or distributor that pre-assigns their role. User lifecycle tracks pending, active, inactive, and rejected states. Crew access requests allow non-crew users to request elevated permissions.

**Drag-and-drop issue builder.** The issue builder is a 2,000-line React component using DnD Kit with mouse, touch, and keyboard sensors. Sortable event items, a quick-assign panel for unassigned approved events, real-time inventory stats, and a visual status timeline. Multiple modal interactions (create, edit, delete, receive shipment, status advance) use portal rendering. Unsaved change detection warns before navigation.

## Source Files

| File | Lines | What It Shows |
|------|-------|---------------|
| [issues.js](src/issues.js) | 898 | Issue lifecycle, print run CRUD, inventory constraints, content locking |
| [auth.js](src/auth.js) | 463 | Google OAuth verification, invite tokens, crew requests, role-based access |
| [database.js](src/database.js) | 764 | sql.js wrapper with atomic writes, migration system, live backup, diagnostics |
| [Issues.jsx](src/Issues.jsx) | 1,997 | Issue builder with DnD Kit, print run management, inventory tracking, status timeline |
