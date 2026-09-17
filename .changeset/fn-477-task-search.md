---
"@runfusion/fusion": minor
---

summary: Header search now finds tasks by title across the project, shows real cards, and adds AI search on Enter.
category: feature
dev: `POST /api/ai/search-tasks` runs a two-turn expand-then-rank pass on the effective Fast & Cheap lane (project → global → inherited execution, including credential instance, thinking level and `testMode`) through the shared `createResolvedAgentSession` seam with no tools; relevance selects at most five verified project-scoped ids, which are then ordered by `createdAt` descending. Budgets are dedicated: 60/hour per (project, IP), 2 concurrent per project / 4 per process, 25s generation, none of which consume a task-execution slot. The header field owns a paginated `GET /tasks/page?q=…` collection independent of the board, fenced by (node, project, query, generation). Remote nodes route through new explicit `GET /proxy/:nodeId/tasks/page` and `POST /proxy/:nodeId/ai/search-tasks` forwards with no local fallback. `TaskCard` gained an opt-in read-only `interactionMode="search-result"`, and `useAgentsMapCache` / `useBadgeWebSocket` gained an opt-in `enabled` flag; all existing consumers are unchanged.
