---
"@runfusion/fusion": patch
---

summary: Task Detail's "is blocking N todo task(s)" now counts your own lane names instead of reading zero.
category: fix
dev: `TaskDetailContent` takes an optional `columnFlagsByTaskId`, forwarded from `App` through `AppModals`; the fan-out useMemo passes it to the wrapper. Omitted, behaviour is byte-identical.
