---
"@runfusion/fusion": minor
---

summary: Generating insights works on the PostgreSQL backend — the insight run executor and stale-run sweeper run in PG mode.
category: feature
dev: Await-converts the insight run executor (insight-run-executor.ts) and the stale-run sweeper (insight-run-sweeper.ts) and widens their store type to InsightStore | AsyncInsightStore, so POST /api/insights/run and /runs/:id/retry drive the async store instead of throwing 503 (getSyncInsightStore removed). The startup/background/drive-by sweeper is now enabled for both backends. The AI extraction step still needs a configured provider at runtime; a run without one records a clean failed run rather than 503. Adds insight-run-execution.pg.test.ts (create→complete, create→fail, retry-with-lineage against embedded PG) to test:pg-gate.
