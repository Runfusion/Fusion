---
"@runfusion/fusion": patch
---

Speed up Agents API boot-path loading by replacing per-request pending approval row scans with an aggregated pending-count query per requester agent. This keeps `/api/agents` responsive on large approval histories and reduces time spent on the initial "Loading agents..." state.
