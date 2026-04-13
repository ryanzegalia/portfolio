# Microsoft Graph / Excel Sync
> Part of the Nexus production automation platform

Three services sync the primary brand's central pricing and mapping data from a SharePoint-hosted Excel workbook into the Nexus database.


## What it is

A three-service pipeline that polls a SharePoint-hosted Excel file for changes via Microsoft Graph, downloads the file when it changes, parses the tabs with pandas, and upserts structured data into the ERP zone of the database. This replaces a manual "watch the shared drive, copy the file, run the sync script" process with fully automated change-detected syncing.

## Primary files

| File | Lines | Role |
|---|---|---|
| `api/services/msgraph_client.py` | 146 | MSAL-based read-only client. Handles refresh token-based auth with auto-rotation (Microsoft rotates refresh tokens periodically -- the client handles the rotation transparently). ETag-based change detection for file downloads. Read-only scoping (`Files.Read` only). |
| `api/services/msgraph_excel_heartbeat.py` | 294 | Background heartbeat. Polls SharePoint every 15 minutes for changes to the shared pricing workbook. ETag-aware -- skips download if unchanged. On change, triggers `erp_excel_sync` to re-parse and upsert. |
| `api/services/erp_excel_sync.py` | 307 | Parses the downloaded Excel workbook into structured ERP data. Handles multiple tabs (POShipments, pricing, mapping). Upserts into `erp_*` and related tables. |

Also consumes:
- `api/services/po_shipment_sync.py` (544 lines) -- reads the `POShipments` tab specifically, covered in [order-fulfillment.md](order-fulfillment.md).

## Scale and verified numbers

- **Heartbeat cadence**: 15 minutes (configurable via `MSGRAPH_POLL_INTERVAL` env var, default 900s)
- **Token scope**: `Files.Read` only -- read-only access, no write path exists
- **ETag-based change detection**: if the file's ETag matches the last-seen value, the download is skipped entirely. The API call to check ETag is free (just a HEAD request).
- **Refresh token auto-rotation**: Microsoft rotates refresh tokens periodically. The client catches the new token from the response and updates its stored copy transparently.

## Key architectural decisions

- **Read-only scope.** The MSAL token is scoped to `Files.Read` only. Nexus cannot accidentally overwrite the authoritative Excel file even if a code bug tried. The write direction is never implemented -- there's no `files_write` method anywhere in the codebase.
- **ETag-aware polling.** The 15-minute cadence is 96 polls per day, but most of them are free -- they just check the ETag header and skip the download. Only when the Excel actually changes does the full download + parse happen.
- **Refresh token rotation.** Microsoft's refresh tokens expire and get rotated. If the client didn't handle rotation, every token expiry would require a manual `scripts/msgraph_auth.py` re-auth. Instead, the client catches the new token from the token endpoint response and overwrites the stored value. Fully self-healing.
- **Pipeline separation.** Three services, one job each: `msgraph_client` handles Microsoft's protocol, `msgraph_excel_heartbeat` handles scheduling and change detection, `erp_excel_sync` handles parsing and writing. Each service is small (146 / 294 / 307 lines) and individually debuggable.
- **Lazy `msal` import.** The `msal` library is not in `api/requirements.txt` -- it's imported lazily inside `msgraph_client.py`. If the library is missing, imports fail gracefully and the heartbeat is disabled with a clear error. Allows the main API to boot on environments that don't need Microsoft Graph integration.

## Inputs and outputs

**Reads from:**
- Microsoft Graph API (`GET /me/drive/root:/path/to/file:/content` for download, `GET` with `If-None-Match` header for ETag check)
- Microsoft identity platform (`POST /token` for MSAL refresh)

**Writes to:**
- `erp_pos`, `erp_po_items`, `erp_po_shipments`, `erp_po_invoices`, and related ERP zone tables (via `erp_excel_sync`)
- `sync_changelog` (field-level changes)
- `api_health_log` (operational metrics)

**Never writes:** Back to SharePoint. The write direction doesn't exist.
