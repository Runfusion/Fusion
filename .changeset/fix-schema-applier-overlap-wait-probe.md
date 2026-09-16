---
"@runfusion/fusion": patch
---

summary: Fix PostgreSQL schema startup on already-stamped empty databases.
category: fix
dev: Guards the overlap-wait drain probe from referencing a missing project table and narrows hook-only schema tests.
