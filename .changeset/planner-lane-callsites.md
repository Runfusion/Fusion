---
"@runfusion/fusion": patch
---

summary: On a workflow with renamed columns, planning writes are no longer refused after a stale-status sweep clears the card.
category: fix
dev: U7 / R3. The five triage call sites of `isTaskStillInPlanningStage` — the under-the-lock guards for `updateTaskAtomic`, `withTaskLock`, `deleteTaskIf`, and discovery — used the legacy `triage` default, so a renamed-workflow card whose planning status had been cleared read as "advanced past planning" and every guarded write was refused. They now read the task's intake column synchronously from the snapshot the discovery pass publishes (these run under the task lock, where nothing may await). A task no pass has published falls back to the legacy id, so the pre-first-poll window is byte-identical. self-healing.ts's three call sites are left to that file's owner per the drift-review split.
