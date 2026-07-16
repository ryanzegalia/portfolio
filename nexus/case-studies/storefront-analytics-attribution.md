# Storefront Analytics and Session-to-Order Attribution

## Problem

The first-party telemetry pipeline (see [Cart telemetry and consent editing](cart-telemetry-consent-editing.md)) had been writing behavioral events since mid-June 2026 with no read surface at all: several thousand page-view events, carrying full acquisition attribution, were accumulating in a table nobody could query except by hand. The company had no view of funnel conversion, traffic sources, or product-level shopper behavior, and no way to answer the question that makes telemetry worth having: which sessions became orders? Compounding that, the pipeline is anonymous by design, with no cross-site identity and no PII in the event stream, so tying a session to an order is not a simple join.

## Approach

The read surface is a five-tab analytics console: **Live** (current visitors and carts, riding the existing presence poll), **Funnel** (view, cart, checkout, and order progression), **Acquisition** (traffic source and campaign attribution), **Products** (per-product view and cart behavior), and **Search** (on-site search terms and their outcomes). Every aggregate row in the funnel, product, and acquisition views drills down a chain that ends at individual session detail, so a surprising number is always inspectable rather than argued with.

Attribution runs through a **session-to-order bridge** that retroactively matches anonymous telemetry sessions to real orders by timestamp proximity at checkout, with matches landing inside sub-15-second windows. Sessions recorded before the bridge existed were matched retroactively, converting "attribution pending" placeholders into order-level attribution without loosening the pipeline's privacy posture.

Money is handled with deliberate distrust of the client. Early telemetry emitted a cart-total field that proved unreliable, so the financial drill-down ("money-stitch") anchors instead on the authoritative order record, joining order total, tax, payment rail and timing, and reconciliation status through the bridge rather than reading them from the event stream.

The console also went through a deliberate plain-English pass: analytics jargon in labels was rewritten, with precise definitions moved into hover explanations, because the audience is company leadership and customer-service reps, not analysts.

## Technical Highlights

- **A data-quality audit ran before leadership saw a number.** The audit caught the funnel undercounting real conversions by roughly 20x due to missing event coverage, the kind of error that, published first and corrected later, permanently discredits a dashboard. The instrumentation gap was closed before the numbers shipped.
- **Raw and cleaned metrics are shown as distinct things.** Bot and internal-employee traffic is filtered into a separate "cleaned" conversion series rather than silently blended, so the headline number is defensible and the methodology is visible.
- **Client-emitted money is treated as a hint, not a fact.** Authoritative financials come from the order record after the bridge match; the emitted total that proved unreliable was demoted rather than patched.
- **Attribution without identity.** The bridge matches on checkout-time proximity instead of fingerprinting or cross-site identifiers, preserving the first-party, anonymous-by-design telemetry posture. Sessions that fail to match stay unattributed rather than guessed.

## Outcome

Phase 1 shipped and was audited in mid-July 2026: the write-only event store became a live console, with order-level attribution operating over live traffic in its first week and the retroactive bridge extending attribution across the accumulated event history. The financial drill-down is staging-verified at the time of writing, and a Returning tab (repeat-buyer share, loyalty distribution, time-to-repeat) is in progress.

## Limitations

Timestamp-proximity attribution is a heuristic, and that is a deliberate consequence of refusing identity tracking: a shopper who lingers at checkout or completes an order much later than their last event may not match, and the bridge leaves those sessions unattributed rather than inventing a link. Conversion metrics are only as good as event coverage, which is exactly why the pre-launch data-quality audit exists as a gate rather than a one-time exercise.

See also: [ADR-036: Poll-based presence](../decisions/036-poll-based-presence.md), [ADR-037: Consent-gated cart editing](../decisions/037-consent-gated-cart-editing.md), [Cart telemetry and consent editing](cart-telemetry-consent-editing.md).
