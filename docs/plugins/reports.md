# Reports Plugin

## Install

1. Open **Settings → Plugins → Fusion Plugins**.
2. In **Bundled Plugins**, click **Install** for **Reports**.
3. Enable the plugin if it is not already started.

When installed and enabled, the plugin registers the **Reports** dashboard view destination.

## Rendering & Export

The reports plugin renders deterministic HTML via `src/render/html-template.ts` using ordered `data-section` blocks and tokenized styles from `src/render/html-styles.ts`. Section toggles and `sectionOrder` are respected from report settings metadata, and both dark/light themes are embedded directly in the output document (no dashboard stylesheet dependency).

Standalone exports are produced by `renderStandaloneReportHtml` in `src/render/standalone-html.ts`. The export is fully self-contained (single document, inlined `<style>`, no remote CSS/fonts, and no non-allowlisted external `href/src` URLs). Exported HTML is cached back into the report store (`rendered_html`, `rendered_html_generated_at`) on first export.

HTTP endpoints:
- `GET /api/plugins/reports/reports/:id/export.html` → attachment download (`Content-Disposition` + `text/html`)
- `GET /api/plugins/reports/reports/:id/preview.html` → body-only HTML fragment for embedded preview viewers

## Dashboard view

The Reports dashboard view is registered as a primary plugin destination (`viewId: "reports"`).

UX includes:
- Reports history list with cadence/status/date/title/agent filtering
- Detail viewer with sandboxed iframe `srcDoc` preview from `/reports/:id/preview.html`
- Section quick-jump sidebar based on stable rendering-contract `data-section` markers
- Compare drawer with two report selectors and section-level diff buckets (added/removed/changed/unchanged)
- Download action that opens `/reports/:id/export.html` for standalone HTML export
