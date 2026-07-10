---
"@runfusion/fusion": minor
---

summary: Cursor CLI models now appear in Fusion's model picker when the Cursor CLI provider is enabled.
category: fix
dev: /api/models additively merges `cursor-agent` model discovery under the `cursor-cli` provider via a short-TTL, single-flight cache (no per-request CLI spawn), and adds `cursor-cli` to configuredProviders when useCursorCli is on so the rows survive the final provider filter. Rows are deduped by provider/id and never displace existing entries. Pattern mirrors FN-7636 (Hermes).
