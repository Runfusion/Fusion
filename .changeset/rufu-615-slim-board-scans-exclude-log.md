---
"@runfusion/fusion": patch
---

summary: Dashboard memory stops climbing as fast: hot dispatch and merge paths no longer load every card's full log.
category: fix
dev: Eight `listTasks({ slim: true })` board scans now pass `excludeLog: true` (dependency and file-scope dispatch gates, worktree ownership, unpause-resume, spawn-agent tool, run-implementation, merger integration worktree, PR comment handler). `slim` alone does not omit the `log` column while derivation is on, so each of those reads materialized every card's log array; a 180 s sampling heap profile on production attributed 925 MiB of still-live allocations to `listTasksImpl -> rowToTask`. `src/__tests__/list-tasks-slim-excludes-log.test.ts` ratchets the remaining 88 unconverted sites so a new one fails CI.
