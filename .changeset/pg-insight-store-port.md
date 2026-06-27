---
"@runfusion/fusion": minor
---

summary: Insights work on the PostgreSQL backend — the Insights dashboard loads instead of erroring.
category: feature
dev: Ports InsightStore to the AsyncDataLayer. Adds AsyncInsightStore (wrapping async-insight-store.ts helpers, incl. 6 new helpers — updateInsight, updateInsightRun [faithful run-lifecycle state machine: terminal-immutable, transition validation, auto completed/cancelled timestamps], listInsightRunEvents, countInsights, countInsightRuns, listStalePendingRuns); getInsightStoreImpl returns it in backend mode; dashboard insights routes await it and the interim 503 is removed for the read/write/cancel surface. The 3 engine reporters stay on graceful fallback (instanceof-gated). Known partial: AI insight-run generation/retry (POST /run, /runs/:id/retry) and the stale-run sweeper remain sync-only and still 503 in PG mode until the run executor is ported. Adds insight-store.pg.test.ts to test:pg-gate.
