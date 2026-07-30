---
"@runfusion/fusion": patch
---

summary: Fix custom workflows being treated as unresolved, which stranded cards in post-U11 intake recovery.
category: fix
dev: `resolveWorkflowIrForTaskWithProvenance` compared the resolved IR's `id` against the requested workflow id and reported `source: "default"` when they differed. `createWorkflowDefinition` stores an authored IR verbatim, so `ir.id` keeps the author's value while the store allocates `WF-NNN` — every such workflow was reported as a guess. The check was also redundant for the three branded degradation paths. A fourth — an id that looks builtin but is not registered — substituted the default without branding it; that substitution is now branded at its source, so the marker check covers every path.
