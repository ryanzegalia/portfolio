# Product Brain

The product-knowledge layer that sits between the ERP/storefront and the customer-facing product page, modeling every sellable product as a graph of option choices, component SKUs, provenance-tracked specs, and computed compatibility, all governed by one review console and served through a versioned public API.

## What it is

This component models every sellable product as a graph rather than the flat descriptions and hand-maintained compatibility tables it supersedes. Each sellable product is modeled as:

- **Option choices that decompose into a bill of materials.** An option a customer picks resolves through option-relationship data into the component SKUs that choice actually adds: a case, an antenna, a faceplate, internal hardware, packaging.
- **SKUs that carry provenance-tracked specifications.** Technical spec values are harvested from support-article sources, and each value keeps a record of where it came from, so any number on the page can be traced back and corrected rather than trusted blindly.
- **Compatibility computed, not typed by hand.** Which products fit together is derived from connector-interface definitions instead of a hand-maintained fitment table. A small set of interface rows generates the fitment edges, so coverage scales with the interface vocabulary rather than with the number of product pairs.
- **One review gate before serving.** All content passes through a single review console with approve, edit, and hide states before the public API serves any of it.

## Scale

- **Spec vocabulary of 61 canonical definitions across 9 groups**, with **145 provenance-tracked spec values seeded to production across 7 products** (as of 2026-06-23).
- **Baseline content tables in production:** approximately 313 product descriptions, approximately 239 features, and approximately 1,114 compatibility relations (as of 2026-06-18).
- **Interface-derived compatibility live in production:** 139 interface declarations derive 860 compatibility links, and 93% of sellable products carry at least one (live counts, 2026-08-03). An adversarial verification pass over derived edges caught 19 incorrect ones (antenna-cable class mismatches) before they could reach recommendations (2026-06-19).
- **Interface-derived compatibility pilot:** 824 fitment edges generated from 36 seeded interface rows, run on an isolated staging clone (as of 2026-06-25).

## Content Review Console

Six separate admin pages were consolidated into one review surface (confirmed shipped to production 2026-06-26). It offers two ways to work:

- **Walk-a-product mode** steps through a single product's content field by field.
- **Queue mode** works a backlog of pending items across products.

Every item carries approve, edit, and hide states, and a provenance drawer answers the question "why does it say this" by surfacing the source behind each spec value. Consolidating the surfaces keeps unreviewed content from reaching customers and gives one auditable place to govern what the public API serves.

## Public serving

A one-fetch product-page aggregate endpoint composes nine content fragments (features, specs, compatibility, kits, FAQ, docs, and head metadata among them) into a single response that is fault-isolated, rate-limited, and cache-friendly, returning content in roughly 300ms (shipped 2026-07-02/03). Fault isolation means one slow or failing fragment degrades that section rather than the whole page, so a single product request does not fan out into nine fragile calls.

## Decomposition validation

Live-query tests confirmed that a configured product option resolves through the option-relationship data to its full component list: case, antenna, faceplate, internal hardware, and packaging. Those same tests surfaced two data-quality classes:

- **Coupling noise.** Some option choices over-add unrelated component families. The decomposition detects and flags these rather than pushing them to the page.
- **Informal components.** Some components exist only as raw SKU strings, not yet promoted to formal entities. The tests surfaced this gap; entity promotion is tracked as follow-up catalog work.

For coupling noise, flagging rather than rendering keeps a catalog data gap from becoming a wrong product page.

## 3D configurator

A proof-of-concept three-pane configurator renders the decomposition in real time in the browser, reusing the same option-to-piece data that drives serving. The alternative it was measured against, a vendor's flat-image approach that precomputes one image per combination, would need roughly 1,600 pre-rendered images for this product. That approach did not fit this context because it scales with the count of combinations rather than the count of pieces, and it cannot reflect a new option without regenerating the full image set. Honest status: this is a prototype. Asset collection is ongoing, and it is not a shipped customer-facing feature.

## Key Decisions

- **[ADR-047: Interface-derived compatibility](../decisions/047-interface-derived-compatibility.md)**. Compute fitment from connector-interface definitions instead of a hand-maintained compatibility table. A hand-maintained table grows with the number of product pairs and drifts as the catalog changes; deriving edges from a small interface vocabulary keeps the truth in one place and lets coverage scale. The pilot (2026-06-25, isolated staging clone) produced 824 fitment edges from 36 interface rows. Separately, an adversarial verification pass over the 491 derived edges caught 19 incorrect ones (antenna-cable class mismatches) before they reached recommendations (2026-06-19).
- **Provenance on every spec value.** Each spec value records its support-article source so the review console can answer "why does it say this." Content served to customers is traceable and correctable rather than anonymous.
- **One review console before serving.** All content clears a single approve/edit/hide surface before the public API exposes it, giving one governed place to catch bad content instead of six separate admin pages.
- **One-fetch product-page aggregate.** Composing nine fragments in a single fault-isolated response keeps a page load from fanning out into nine independent failure points and keeps one slow fragment from taking down the page.

## Integration Points

**Reads from:**
- The ERP/storefront catalog for the sellable products and their options.
- Option-relationship data for the bill-of-materials decomposition of each option choice.
- Support-article sources for spec harvesting, retained as provenance on each value.
- Connector-interface definitions, the input the compatibility engine derives fitment edges from.

**Writes to:**
- The content tables that back the page: product descriptions, features, spec values, and compatibility relations.
- Review-console state (approve, edit, hide) recorded per content item.

**Serves:**
- The customer-facing product page, through the versioned one-fetch aggregate endpoint.
- The review console UI, including the provenance drawer.

## Files

File-level detail lives in the repo. The one load-bearing count worth noting here: the render resolver module is 348 lines.
