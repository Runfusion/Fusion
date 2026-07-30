---
"@runfusion/fusion": patch
---

summary: Fix custom workflows being treated as unresolved, which stranded cards in post-U11 intake recovery.
category: fix
dev: `resolveWorkflowIrForTaskWithProvenance` compared the resolved IR's `id` against the requested workflow id and reported `source: "default"` when they differed. `createWorkflowDefinition` stores an authored IR verbatim, so `ir.id` keeps the author's value while the store allocates `WF-NNN` — every such workflow was reported as a guess. The check was also redundant: all three degradation paths brand the IR via `markFellBack`, which is checked first.
