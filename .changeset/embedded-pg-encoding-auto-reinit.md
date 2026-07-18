---
"@runfusion/fusion": patch
---

summary: Fusion now auto-repairs embedded PostgreSQL clusters left in the non-UTF-8 encoding state by earlier versions.
category: fix
dev: "Issue #2286 follow-up: on the encoding-conversion schema failure, the startup factory proves the embedded cluster is non-UTF-8 AND empty (no tables in project/central/archive, no recorded migrations — guaranteed for affected installs since the baseline never applied) and that this process owns the postmaster, then deletes the data dir and re-boots once with the UTF-8 initdb defaults. Joined instances and any non-proven state keep the manual re-init hint."
