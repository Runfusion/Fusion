---
"@runfusion/fusion": patch
---

summary: Prevent optional core audit sinks from delaying task lifecycle operations.
category: fix
dev: Core best-effort run-audit emitters now use a bounded, non-rejecting seam.
