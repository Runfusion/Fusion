---
"@runfusion/fusion": minor
---

summary: Research runs actually execute on the PostgreSQL backend instead of staying queued forever.
category: feature
dev: Await-converts the engine ResearchOrchestrator + ResearchRunDispatcher to drive InsightStore | AsyncResearchStore (every this.store.* call awaited; addEvent→appendEvent for union compatibility) and removes the instanceof ResearchStore gate in ProjectEngine.start that disabled the orchestrator/dispatcher in PG mode. Exports AsyncResearchStore from @fusion/core. A queued run now advances queued→running→completed/failed in PG; the AI/web step still needs runtime providers (a run with none fails cleanly). Adds research-execution.pg.test.ts to test:pg-gate.
