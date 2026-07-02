---
"@runfusion/fusion": minor
---

summary: Research works on the PostgreSQL backend — the Research dashboard loads and runs CRUD instead of erroring.
category: feature
dev: Ports ResearchStore to the AsyncDataLayer. Adds AsyncResearchStore (12 new helpers incl. faithful replicas of the run-lifecycle state machine — updateResearchStatus per-status auto-lifecycle fields, terminal-immutability, transition validation — and the retry gate/lineage in createResearchRetryRun); getResearchStoreImpl returns it in backend mode; dashboard research routes await it and the interim 503 is removed. AI research EXECUTION (engine ResearchOrchestrator/dispatcher, agent-tools research tools, CLI research run) stays degraded in PG mode behind instanceof guards — same boundary as the insight run executor. Adds research-store.pg.test.ts (13 tests incl. lifecycle machine + retry gate) to test:pg-gate.
