# Per-SKU Demand-Model Routing by ADI/CV2 Classification

**Status:** Accepted | **Date:** 2026-06-20 | **Theme:** forecasting

## Context

Demand forecasting across a full catalog runs into a single-model problem: SKUs do not behave alike. Some sell in smooth seasonal cycles, some sell intermittently with long gaps between orders, and some are lumpy, with irregular large orders. A method tuned for one pattern misreads the others, so a single model applied to every SKU misreads the patterns it isn't tuned for.

## Decision

Each SKU is statistically classified by its average demand interval (ADI) and demand-size variance (CV2), then routed to a method matched to its pattern: AutoETS with a 12-month seasonal cycle for seasonal SKUs, Croston SBA for intermittent SKUs, and a recent-mean baseline for the rest. Rolling-holdout backtests score each method by WAPE and MASE, and on a high-volume SKU the routed forecast tracked the human planner's seasonal curve at a 0.97 shape correlation.

## Alternatives Considered

- **One global model for the whole catalog.** This did not fit the context because seasonal models hallucinate seasonality on intermittent SKUs, producing forecasts that are not there in sparse order histories.
- **Deep-learning forecasters.** These did not fit the context at this scale: the catalog is hundreds of SKUs with small per-SKU histories, which is thin data for a neural model, and forecasts have to stay explainable to a human planner.

## Consequences

Each class of SKU gets a method whose behavior a planner can reason about, which matters because forecasts must stay explainable to the human planner. The ADI/CV2 thresholds that decide routing need periodic review. A known limitation remains: the routing is conservative on ramping SKUs (reasoning reconstructed from system behavior: forecasts may lag recent growth until more order history accumulates).