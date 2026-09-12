---
"@runfusion/fusion": patch
---

summary: Fix tasks stuck failing forever after waiting on another task that touched the same files.
category: fix
dev: The overlap-wait publication fence compared a caller-supplied prompt hash against `sha256(row.prompt)` read from `project.tasks`, which has no `prompt` column, so the comparison could never hold for a task carrying a spec and every claimed episode was refused publication indefinitely (observed: 122 dispatch cycles per task). Both `claimTaskOverlapWaitImpl` and `completeTaskOverlapWaitImpl` now anchor the plan identity on the episode row's durable `plan_fingerprint` column; a mid-analysis plan revision is still fenced by the existing claim-vs-publication identity equality. The claim also no longer null-wipes that column, which had made `revalidatePendingOverlapWaitsAtGraphNode` treat every targeted repair as a plan change.
