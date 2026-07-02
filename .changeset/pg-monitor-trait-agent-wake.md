---
"@runfusion/fusion": fix
---

summary: Regression storm-guard and agent wake-on-message work on the PostgreSQL backend.
category: fix
dev: monitor-trait runMonitorOnRegression drops its backend-mode early return and routes the storm guard (countRecentAutoFixTasksAsync/claimIncidentForFixTaskAsync/attachFixTaskAsync/releaseIncidentFixTaskClaimAsync) through the AsyncDataLayer in PG, preserving the claim→createTask→attach→release semantics. The agent wake hook handleMessageToAgent becomes async and reads via AgentStore.getAgent (async) instead of the sync getCachedAgent that threw in PG; the onMessageToAgent hook type widens to allow a Promise and message-store awaits it inside its existing send-never-fails try/catch.
