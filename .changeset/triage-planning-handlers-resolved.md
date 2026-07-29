---
"@runfusion/fusion": patch
---

summary: On a workflow with renamed columns, Start begins planning at once and moving a card no longer kills its planner.
category: fix
dev: U7 / R3. The planning wake and planning-evacuation handlers are synchronous `task:updated` listeners, so they read a lane snapshot published by each discovery pass rather than resolving an IR per board update (which for evacuation would also have delayed an abort that is synchronous today). Renamed workflows had opposite failures: the wake never fired (Start appeared dead until the next poll tick), and evacuation fired on an intake -> hold move, killing a healthy planning session mid-spec. A task no pass has published yet falls back to the legacy `triage`/`todo` pair, so behavior in that window is byte-identical to today and the conversion cannot regress a workflow that never renamed anything.
