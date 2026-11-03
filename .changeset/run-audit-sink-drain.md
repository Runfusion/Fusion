---
"@runfusion/fusion": minor
---

summary: Stop losing run-audit evidence under load: buffered audit writes, an on-disk backup, and sink diagnostics.
category: fix
dev: Best-effort `emitBoundedRunAudit` hands rows to a per-store drain (25ms window, 50-row batches, 1000-row ceiling) instead of racing a 2s timer against one pool connection each; refused batches spill to `.fusion/logs/run-audit-dead-letter.jsonl` and replay by primary key. `emitBoundedRunAuditWithOutcome`, `recordRunAuditEvent`, and the transactional writers keep commit-before-return, so `store:open` moved to the outcome seam. Kill switch `FUSION_RUN_AUDIT_BUFFERED=0`; bounds via `FUSION_RUN_AUDIT_SINK_{QUEUE_MAX,BATCH_MAX,FLUSH_WINDOW_MS,WRITE_BOUND_MS}` and `FUSION_RUN_AUDIT_DEAD_LETTER_MAX_BYTES`. New `GET /api/diagnostics/run-audit-sink` (add `?rows=1` for the spill tail). Readers that count rows a same-process producer just emitted must call `TaskStore.flushRunAuditSink()` first.
