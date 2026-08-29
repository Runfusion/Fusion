---
"@runfusion/fusion": patch
---

summary: Creating a task from an Insights recommendation is no longer slow on large boards.
category: performance
dev: Adds indexed findTaskByProposalClaimId and listTasksBySourceLineage reads, removes near-duplicate fullRows hydration, and registers migration 0059.
