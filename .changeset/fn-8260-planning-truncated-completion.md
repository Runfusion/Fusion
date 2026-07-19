---
"@runfusion/fusion": patch
---

summary: Planning Mode no longer accepts a truncated final plan with empty deliverables.
category: fix
dev: parseAgentResponse now rejects truncation-repaired completions; acceptance paths retry or surface a retryable error instead of showing an incomplete checkpoint summary.
