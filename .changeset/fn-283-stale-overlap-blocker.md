---
"@runfusion/fusion": patch
---

summary: Clear stale file-scope overlap waits automatically after their blocker finishes.
category: fix
dev: Reconciles self-healing, completion fan-out, and scheduler dispatch with fresh lease checks and exact-ID atomic clears.
