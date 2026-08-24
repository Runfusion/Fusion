---
"@runfusion/fusion": patch
---

summary: Make task reset safely fence active planning sessions.
category: fix
dev: Reset adds planner reset disposers, releases held symbol locks, and clears discarded-run projections while retaining operator input.
