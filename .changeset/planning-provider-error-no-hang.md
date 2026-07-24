---
"@runfusion/fusion": patch
---

summary: Planning Mode no longer hangs on "Generating plan" after a provider error; it surfaces a retryable error.
category: fix
dev: Provider errors thrown after a planning session persists "generating" (agent rebuild, history replay, legacy sync start) now land the session in a persisted retryable error with an SSE error event; the stream route reconciles stranded generating sessions past the watchdog window via `reconcileStalePlanningGeneration`.
