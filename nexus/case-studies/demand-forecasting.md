# Case Study: Demand Forecasting Engine

**Status: built and backtested, not yet activated in production.** The production activation flag has not been enabled. A live check on 2026-07-09 returned 0 rows in the velocity output table on production. The engine is validated against held-out history and against the purchasing lead's own numbers, and activation is being held deliberately until one open data-credit path is closed (see Limitations).

## Problem

Replenishment planning ran out of a single hand-maintained Excel workbook kept by the purchasing lead. The workbook spanned roughly 40 tabs and about 186,000 formulas, re-syncing on a roughly 15-minute cadence, and it encoded years of judgment that lived in one person's head. There was no statistical baseline to check that judgment against, no reproducible way to reforecast when demand shifted, and no path to hand the process off if that person was unavailable. The goal was to reproduce and pressure-test the workbook's output with a per-SKU statistical model: not to replace the buyer's judgment, but to give it a second opinion that could be audited.

## Approach

The engine classifies every SKU before it forecasts it. Two demand statistics, average demand interval (ADI) and squared coefficient of variation (CV2), route each SKU to the model class that fits its pattern: **AutoETS for smooth seasonal demand** with a 12-month seasonal period, **Croston's SBA for intermittent demand** where sales arrive in sparse bursts, and a recent-mean estimator for everything that fits neither. Picking the model per SKU matters because a single global model over-smooths intermittent parts and under-fits seasonal ones. The classification step is what lets one pipeline serve a catalog with very different demand shapes.

Two data-hygiene corrections sit underneath the models, and both changed the numbers materially. Order-status semantics were reverse-engineered from the data's own fingerprints rather than trusted from documentation, and switching the status filter from an allowlist to a denylist recovered **9,484 units of real demand** that the allowlist had been silently dropping. Separately, a **757,764-row, 37-month inventory-transaction ledger** was ingested so that stockout periods are treated as censored demand rather than as genuine zeros. Without that correction, every period a SKU was out of stock would read as "nobody wanted it" and depress the forecast.

Everything is scored before it is trusted. A rolling-holdout backtest computes WAPE, MASE, and bias per SKU and exposes the results through an internal API, so any SKU's forecast quality can be inspected rather than assumed. On a high-volume SKU the backtest returned a WAPE of 0.41 and a MASE of 0.995, meaning the model's error was roughly in line with a simple baseline forecast.

## Technical Highlights

- **Classify-then-forecast routing.** ADI/CV2 demand statistics assign each SKU to AutoETS, Croston's SBA, or a recent-mean estimator, so one pipeline handles seasonal, intermittent, and flat demand without a single model compromising across all three. The routing choice is written up in [ADR-041: demand model routing](../decisions/041-demand-model-routing.md).
- **Denylist over allowlist for order status.** Reversing the filter recovered 9,484 units of demand the previous allowlist dropped, after the status codes were reverse-engineered from data fingerprints. Rationale in [ADR-042: order-status denylist](../decisions/042-order-status-denylist.md).
- **Censoring correction from the transaction ledger.** A 757,764-row, 37-month ledger lets stockout periods read as missing demand rather than zero demand, so scarcity does not get mistaken for lack of interest.
- **Per-SKU accuracy API.** Rolling-holdout WAPE, MASE, and bias per SKU are queryable, which turns "is the forecast any good" into a lookup instead of an argument.
- **Isolated build lane with a green end-to-end suite.** The build carries 22 of 22 end-to-end tests passing, plus 67 unit tests, so the scoring path can be changed without silently breaking.

## Outcome

The engine reproduces the workbook's statistical core in an auditable form and adds a per-SKU accuracy record the spreadsheet did not have. One key validation is against the human expert it is meant to support: independently derived seasonal indices for a high-volume SKU matched the purchasing lead's hand-kept seasonal curve with a **0.97 shape correlation** (single-SKU validation). That agreement is evidence that the automated seasonality is learning the same real pattern the buyer learned by hand.

Both load-bearing decisions trace to documented reasoning rather than intuition, which is why the model routing and the recovered demand are captured as ADRs: [ADR-041: demand model routing](../decisions/041-demand-model-routing.md) and [ADR-042: order-status denylist](../decisions/042-order-status-denylist.md).

## Limitations

One data-credit path is open, and it is the reason activation is being held. Component SKUs that sell inside kits and bundles are not yet credited back to component demand in the order-derived series. Spot checks on two SKUs showed the internal series captured only 33 to 71 percent of the purchasing lead's manually recorded unit totals, even though the seasonality shape still matched at 0.97. The shape is right; the level is undercounted for bundled components. Turning the engine on before that credit path is closed would hand the buyer confident-looking numbers that run low for exactly the SKUs where bundling matters, so activation stays off until the kit-to-component attribution is built. Not-yet-activated is a deliberate state here, not an unfinished one.
