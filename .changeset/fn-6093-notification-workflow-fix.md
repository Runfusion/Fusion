---
"@runfusion/fusion": patch
---

Fix workflow/AI merge ntfy notification delivery by preserving merge-backed task metadata, treating an empty ntfy event allowlist as the documented default events, and allowing failed/no-provider notification attempts to retry after settings refresh.
