---
"@runfusion/fusion": patch
---

summary: Finished cards on a renamed board now show their completion date.
category: fix
dev: `lifecycleDates` in TaskCard omitted `isCompleteColumn`/`isArchivedColumn` from its dependency list; both derive from the async `taskColumnFlags` prop.
