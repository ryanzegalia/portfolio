# The Order Desk
> Part of the Nexus production automation platform

One screen for a sales rep taking an order -- from finding the customer through pricing the freight and placing it -- backed by a reconciliation tripwire that keeps watching the order after it lands.

## What it is

A single-page order workstation for phone and dealer sales, in production since July 2026. The rep pins a customer on the left and works three tabs across the page: shoppers on the site right now, the order being built, and quotes saved earlier. Identity resolution runs underneath the customer search, so the several ERP accounts one real person holds collapse into a single result, and the rep can move between that person's accounts without losing the order in progress.

Everything the desk writes goes into the ERP through the same interface the ERP's own order screen uses, so a desk order and a hand-keyed order are the same kind of record, and nothing downstream has to know which was which.

## Files

| File | Lines | Role |
|---|---|---|
| `dashboard/order-desk.html` | 2,630 | The one-page desk -- customer rail, live-shopper tab, order builder, quote tab. |
| `api/services/quote_service.py` | 268 | Saved quotes -- a part-built order can be saved, shared with another rep, or duplicated. |
| `api/services/quote_convert_service.py` | 587 | Converts a saved quote into a live ERP order through the same write path the builder uses. |
| `api/services/desk_recon_service.py` | 724 | The post-placement reconciliation tripwire (below). |
| `api/routes/v1/cart_assist.py` | 529 | The live-shopper tab's backend -- the consent-gated cart editing surface. |

## Scale

- **One page** replaces the legacy path's three separate pages and the mid-call jumps between them
- **4 desk-owned tables**: `desk_order_snapshots`, `desk_order_reconciliation_alerts`, `desk_recon_pending`, `desk_pickup_contacts`
- **Two tripwire cadences**: a near-immediate check enqueued after every desk write, plus the order heartbeat's continuing diff on every re-ingest

## Key decisions

- **Write through the ERP's own order interface.** The desk does not maintain a parallel order store. Orders, lines, and posted payments land in the ERP exactly as if an operator had keyed them on the ERP's own screen, which keeps every downstream consumer -- fulfillment, reporting, reconciliation -- indifferent to where an order came from.
- **Record intent, then keep checking it.** After every order the desk places or edits, it records the intended final state it just read back -- the transaction summary, applied deals, line items, shipping method, customer email, order status, and posted payment ids -- into `desk_order_snapshots`. When the ERP later re-ingests or recomputes that order, the order heartbeat re-reads the authoritative state and diffs it against the recorded intent. Any drifted field (an expired deal, recomputed tax, a hand edit, a payment voided out-of-band, a re-selected shipping method) opens a `desk_order_reconciliation_alerts` row and emails the operator naming the drifted fields, with an investigation hint per field. Per-write read-backs prove a write landed at write time; the tripwire proves it stays landed. See [write-safety.md](write-safety.md) for the write contract this extends.
- **Identity-resolved customer search.** The search result is a person, not an account. The identity spine collapses the duplicate accounts underneath (see the [identity resolution case study](../case-studies/identity-resolution.md)), and the rep switches accounts without restarting the order.
- **Consent-gated editing on the live tab.** For a shopper already on the site, the rep stages the whole change, the shopper's own browser renders a preview, and it executes through the storefront's native cart only after the shopper approves. See the [cart telemetry case study](../case-studies/cart-telemetry-consent-editing.md).
- **Freight is priceable and overridable in place.** The ship-to and live carrier rates resolve in the same screen, and the rep can override freight when the rate table does not cover what is shipping.

## Integration Points

**Reads from:**
- The identity spine (customer search and account collapse)
- The live presence store (the shoppers-on-site tab)
- Stock rollups per line, and the carrier rate APIs for freight

**Writes to:**
- The ERP, through its own order interface (orders, lines, posted payments)
- The quote tables (saved, shared, duplicated quotes)
- `desk_order_snapshots`, `desk_recon_pending` (recorded intent), `desk_order_reconciliation_alerts` (drift findings)
