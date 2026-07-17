---
"@runfusion/fusion": patch
---

summary: Failed tasks with pre-fix promotion history can no longer auto-promote past the failure-provenance guard.
category: fix
dev: Removed the promoter's own recovery line ("Auto-recovered: task work was complete but stranded") from CLEAN_COMPLETION_MARKERS in completed-promotion-failure-provenance.ts; clean-completion evidence is now execution outcomes only (accepted/implicit fn_task_done). FN-8141 follow-up 2.
