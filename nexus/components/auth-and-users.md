# Authentication and User Management
> Part of the Nexus production automation platform

Handles dashboard login, session management, and the ERP license seat monitoring for a mid-size company team.

Three services handle dashboard auth plus the ERP license seat monitoring.

## What it is

A dual-auth model -- company portal OAuth (JWT) for employees and admin password path for outage recovery -- with template-level access control, session management via the database, and a companion seat monitor that tracks the ERP license availability.

## Primary files

| File | Lines | Role |
|---|---|---|
| `api/routes/v1/auth.py` | 383 | Route-level auth handlers. Dual auth: password (admin) or OAuth (Portal JWT validation). Rate-limited login. HMAC-based password hashing. |
| `api/routes/v1/users.py` | 476 | Admin-only CRUD for dashboard users. Template access patterns (regex-based), page permissions, group memberships. |
| `api/services/user_service.py` | 985 | User authentication, session management, template access control for dashboard users. Handles lazy user creation from Portal OAuth (default role `user`, no template access). |
| `api/services/seat_monitor.py` | 228 | Monitors the ERP license seat availability by scraping the unauthenticated `the vendor login page` page. State machine: CONNECTED -> WARNING -> DISCONNECTED. Fail-open: allows login after 5 consecutive failures or 5 min stale data. 55s scrape interval, thread-safe. |

## Scale and verified numbers

- **Login rate limit**: per-IP throttle (configurable)
- **Session TTL**: configurable (default from config)
- **User roles**: `admin` (full access), `user` (assigned-template access only)
- **Seat monitor scrape cadence**: 55 seconds
- **Seat monitor fail-open threshold**: 5 consecutive failures OR 5 minutes of stale data before allowing connections despite unknown seat state

## Key architectural decisions

- **Dual auth: OAuth + admin password path.** Primary flow is company portal OAuth -- only employees with `EMPLOYEE` role in their JWT can access the dashboard. Customer accounts are blocked. The admin password path exists for Portal outage recovery, gated behind environment-specific credentials.
- **Lazy user creation.** On first successful OAuth login, a user row is created automatically with role `user` and no template access. An admin then grants access via the Users page. Prevents manual user onboarding by using Portal's existing employee directory.
- **Template-level access control.** Users can see dashboard pages filtered by their assigned template access. `user_template_access` supports exact-name patterns and wildcards like `mjg_%`. Access checks happen in `page-guard.js` on the frontend and `@require_page_access()` on the backend.
- **DB-backed sessions, not Redis.** Flask sessions live in the `auth_sessions` table in Postgres. Redis is NOT used for session storage -- sessions survive Redis outages. See [ADR-014](../decisions/014-redis-for-cross-worker-shared-state.md).
- **Fail-open seat monitor.** If the scrape path is broken (the ERP login page layout changed, network issue), seat_monitor falls back to "allow connections" after a threshold. Rationale: better to let an operator work than to lock them out because of a monitoring bug.
- **State machine for seat availability.** CONNECTED (>=2 seats free) -> WARNING (1 seat left) -> DISCONNECTED (0 seats free). Transitions are logged. Dashboard header shows the current state as a colored badge.

## Inputs and outputs

**Reads from:**
- company portal API (JWT validation, employee role check)
- `users`, `auth_sessions`, `user_template_access`, `user_page_access`, `user_group_membership`, `permission_groups` (the auth tables)
- the ERP `the vendor login page` (unauthenticated scrape for seat count)

**Writes to:**
- `users` (lazy creation on OAuth, updates via admin UI)
- `auth_sessions` (login creates, logout invalidates)
- `sync_changelog` (admin role changes, session events)

## Security notes

- Login is rate-limited per IP to prevent brute force against the admin password path.
- Passwords are stored using HMAC-based password hashing.
- Portal JWTs are validated against the Portal's public key, not just decoded client-side.
- Session tokens are 32-byte URL-safe random strings. The `auth_sessions` table's `session_token` column is the primary key.