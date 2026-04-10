---
"@gsxdsm/fusion": patch
---

Suppress per-tool triage stdout spam during `fn dashboard` / `fn serve` runtime

Triage agent tool calls no longer emit per-tool lines like `[triage] FN-XXX tool: read` to stdout. This reduces terminal noise while preserving:
- Internal observability via task agent logs (`fn task logs`)
- Stuck-task heartbeat tracking via `StuckTaskDetector.recordActivity()`

This aligns with project memory guidance to keep engine diagnostics high-signal and avoid noisy low-value terminal spam.
