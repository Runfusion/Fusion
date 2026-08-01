---
"@runfusion/fusion": patch
---

summary: Surface how an implementation session actually ended, including when the executor moved the card itself.
category: internal
dev: Adds a closed `ImplementationExit` enum (`engine/executor/implementation-exit.ts`) reported from six completion-adjacent exits in `runImplementation` and announced by the execute seam as `NodeCompleted.exit` on the U3 lifecycle bus. Routing is byte-identical for every exit; nothing branches on an exit id (R5 — reactions only).
