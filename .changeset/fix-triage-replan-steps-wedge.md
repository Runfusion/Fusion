---
"@runfusion/fusion": patch
---

summary: Fix tasks getting stuck in Planning forever after a plan review asks for revisions.
category: fix
dev: `hasAdvancedPastPlanning` (replan-target.ts) counted `steps.length > 0` as proof a task had advanced past planning. Replan cards legitimately retain the steps their previous planning pass materialized, so the guard at triage's `specifyTask` claim silently skipped its `status:"planning"` write, re-claimed the card every poll, and starved healthy cards out of `maxTriageConcurrent`. Steps are no longer advancement evidence in a planner lane ("triage", or "todo" for plan-in-place workflows carrying a planning status); worktrees and execution/terminal columns still are, preserving FN-7977. The primary claim path now warns instead of skipping silently.
