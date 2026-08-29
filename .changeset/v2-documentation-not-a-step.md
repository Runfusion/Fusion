---
"@runfusion/fusion": patch
---

summary: Coding (Ideas) V2 no longer plans a Documentation step — the review milestone owns delivery.
category: fix
dev: Restoring the default planning prompt to bring `Testing & Verification` back also restored `### Step {N}: Documentation & Delivery`, because the abandoned `planning-implementation-only` seam stripped both in one anchored block. The result was duplicated work: the executor and the in-review Documentation milestone each wrote a delivery note, registered artifacts, and created follow-up tasks, and both wrote task document `docs`, so the review pass silently overwrote the executor's. New `stripDocumentationDeliveryStep` in `builtin-workflow-prompts.ts` removes ONLY the documentation block (keeping `Testing & Verification`) and degrades to an appended prohibition if the anchors stop matching; `builtin-coding-ideas-v2-workflow-ir.ts` applies it to its own copy of the planning prompt. Repository documentation stays implementation work — the executor updates a doc its change made wrong inside the step that made it, so Code Review sees it in the diff. `builtin:coding` and `builtin:coding-ideas` keep the shared template untouched.
