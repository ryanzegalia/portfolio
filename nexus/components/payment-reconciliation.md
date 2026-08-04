# Payment Reconciliation
> Part of the Nexus production automation platform

Compares what the ERP says it collected against what the payment gateways actually settled, order by order, and turns the comparison into a standing per-order verdict.

## What it is

The ERP records a payment when its own checkout tells it to, and nothing after that ever confirms the money arrived. The payments live in the ERP, the settlements live at the gateways, and before this subsystem the two were never compared -- whether an order had genuinely been paid for was not a question either system could answer alone.

This subsystem mirrors both sides read-only and joins them into a per-order verdict, so any order can be asked whether it is verified, partly verified, still pending, or shipped with nothing behind it.

## Files

| File | Lines | Role |
|---|---|---|
| `api/services/payment_recon_heartbeat.py` | 253 | The verdict engine -- joins mirrored ERP payments to mirrored settlements, writes per-order verdicts. |
| `api/services/erp_payments_heartbeat.py` | 240 | Read-only mirror of the ERP's own payment records. |
| `api/services/card_gateway_payments_heartbeat.py` | 202 | Read-only mirror of the card gateway's settlement feed. |
| `api/services/gateway_transactions_heartbeat.py` | 246 | Read-only mirror of the gateway transaction feed. |
| `api/services/paypal_transactions_heartbeat.py` | 184 | Read-only mirror of PayPal transactions. |
| `api/services/pos_payments_heartbeat.py` | 197 | Read-only mirror of the point-of-sale processor. |

## Scale and verified numbers

- **Per-order verdicts** maintained in `order_money_verified` (live table)
- **First full run**: surfaced 92 orders that had shipped against payments the gateway never received -- the ERP's checkout had been marking orders paid through a third-party card SDK the payment provider was winding down, and 91 of the 92 had no transaction at the gateway
- **Match keys**: card payments join on the exact transaction reference the gateway issues; PayPal reconciles on amount, brand, and a three-day window, because the ERP stores a third identifier that appears on neither side

## Key decisions

- **Read-only mirrors on every rail.** The reconciliation never writes to a payment system. Both sides are mirrored locally by dedicated heartbeats and joined there -- the same read-only reconciliation pattern the tax pipeline established (see [ADR-015](../decisions/015-tax-engine-reconciliation-read-only-pattern.md)), applied to money.
- **Unknown is a verdict.** An order the rails cannot settle either way gets its own verdict and is never assumed paid.
- **Nothing reverses on its own.** A flagged order goes in front of a person with both sides shown. If a payment is voided as unverifiable, the order is deliberately left unlocked, because a locked order cannot accept a payment and the money still needs collecting.
- **Billing-page cross-check on the worst class.** Orders that shipped with no payment on record are each re-checked against the ERP's own billing page before anyone acts, so the review queue carries a confirmation per row rather than a suspicion.

## Integration Points

**Reads from:**
- the ERP REST API and office backend (payment records, billing pages)
- The payment gateways' transaction and settlement APIs (read-only)

**Writes to:**
- The local payment mirrors (one table per rail)
- `order_money_verified` (the per-order verdict)
- `sync_changelog` (cross-cutting activity feed)
