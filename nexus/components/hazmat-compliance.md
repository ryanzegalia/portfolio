# Hazmat Compliance and DGD PDF Generation
> Part of the Nexus production automation platform

Generates IATA Shipper's Declaration for Dangerous Goods PDFs for every hazardous shipment.


## What it is

A small, specialized subsystem that generates the official IATA DGD (Dangerous Goods Declaration) PDF form for hazardous materials shipments. the primary brand ships industrial wireless products under UN0454, and every shipment requires a properly completed DGD form. Nexus takes an order barcode, pulls the order/contact data from the ERP and the fulfillment MySQL replica, overlays the data on the official IATA template, and generates a print-ready PDF.

## Primary files

| File | Lines | Role |
|---|---|---|
| `api/routes/v1/hazmat.py` | 328 | HTTP surface -- scan order barcode -> preview -> generate DGD PDF. Fetches order/contact data from the ERP REST API. |
| `api/services/hazmat_pdf.py` | 329 | ReportLab + PyPDF2 overlay engine. Uses the official IATA template PDF as the base; overlays order-specific data at pre-mapped coordinates. |

## Scale and verified numbers

- **UN0454 classification** (hardcoded -- the specific hazmat class for industrial wireless articles)
- **Authorized signatories** pre-defined in the code (a fixed, regulatory-approved list of authorized signatories)
- **Coordinate mapping**: SVG coordinate system converted to PDF coordinates via `pdf_y = page_height - svg_y`
- **Two PDF libraries used**: ReportLab for generating the overlay canvas, PyPDF2 for merging with the template base PDF

## Key architectural decisions

- **Overlay approach, not regeneration.** The IATA DGD form has a specific layout that must be preserved exactly (regulatory requirement). Instead of recreating the form in ReportLab, Nexus uses the official template PDF as the base and overlays only the data fields on top. The template is a PDF file; the overlay is a generated canvas; PyPDF2 merges them.
- **SVG-to-PDF coordinate mapping.** Field positions on the DGD form were measured in SVG coordinates (which start at top-left) and need to be converted to PDF coordinates (which start at bottom-left). The conversion is `pdf_y = page_height - svg_y`, applied at rendering time.
- **Hardcoded UN0454 and authorized signatories.** These are regulatory values that don't change per shipment. Hardcoding them prevents operator error -- you can't accidentally ship under the wrong class by editing a form field.
- **Fetches data from two sources.** Order data comes from the ERP REST API (`erp_rest_client.py`). Shipping address and contact data come from the AWS RDS MySQL fulfillment read replica (`fulfillment_db.py`). Both are required for a complete DGD form.

## Inputs and outputs

**Reads from:**
- the ERP REST API (`GET /v1/order`, `GET /v1/contact`)
- AWS RDS MySQL fulfillment read replica (via `fulfillment_db.py`)
- The IATA DGD template PDF (static file in the codebase)

**Writes:**
- Generates a PDF file as the HTTP response. The PDF is not persisted to disk -- it's generated on demand and streamed to the operator's browser for printing.

**Triggers:**
- Operator scans an order barcode on `hazmat.html`
- Dashboard UI requests the PDF for preview and/or download

## Regulatory context

DGD forms are required by IATA (International Air Transport Association) for every air shipment of dangerous goods. the primary brand ships industrial wireless articles under UN0454 ("Fireworks, 1.4G"). Each shipment requires a completed DGD form signed by an authorized signatory. A form error can result in a shipment being rejected by the carrier, causing delivery delays and regulatory exposure.

Automating DGD generation eliminated a ~10-minute per-shipment manual process during which operators would fill out a Word template, save as PDF, print, sign, scan, and attach to the order. The automation reduced it to scan-barcode -> click-print.
