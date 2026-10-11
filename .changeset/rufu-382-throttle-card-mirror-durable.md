---
"@runfusion/fusion": patch
---

summary: A card waiting on a planner slot always gets its own "waiting for capacity" History line.
category: fix
dev: The plan-throttle dedupe marker is committed only after the run-audit row and every named card's mirrored History line have landed (`logEntryOnce`, deduped per gate signature); a refused mirror leaves the marker unset so the next poll re-announces.
