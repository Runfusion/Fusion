---
"@runfusion/fusion": patch
---

summary: Harden task-pinned orphan preservation and retention against unsafe recovery cleanup.
category: fix
dev: Serializes recovery under the pinned-path reservation, bounds retained orphans, and excludes recovery containers from scans.
