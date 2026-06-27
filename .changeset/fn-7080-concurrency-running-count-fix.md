---
"@runfusion/fusion": patch
---

summary: Concurrency panels now show the real number of running agents instead of 0 when tasks are in progress.
category: fix
dev: global-concurrency running counts (currentlyActive/projectsActive) are now derived live from in-progress task columns, mirroring the /projects/:id/health computation, instead of slot/health bookkeeping that the default in-process runtime never updates.
