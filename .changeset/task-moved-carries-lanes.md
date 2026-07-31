---
"@runfusion/fusion": patch
---

summary: Board renames no longer silently disable scheduler auto-claim invalidation and lane guards.
category: fix
dev: `task:moved` payloads now carry emitter-resolved `lanes` (`TaskMoveLanes`); listeners prefer them over the sync IR resolver, which returns the default workflow under PostgreSQL.
