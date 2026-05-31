---
"@runfusion/fusion": minor
---

Add mission delete tooling for agents: `fn_feature_delete`, `fn_slice_delete`, and `fn_milestone_delete`.

Mission feature/slice/milestone deletes now enforce a linked live-task guard by default and return clear conflict errors. Callers can pass `force: true` to clear mission linkage and proceed with hard deletion.
