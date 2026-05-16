---
"@runfusion/fusion": patch
---

Speed up initial Agents view load by batching linked-task column lookups instead of hydrating each task, and by replacing per-agent run-history scans in `/api/agents/stats` with a single aggregated run-status query.
