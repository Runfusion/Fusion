---
"@runfusion/fusion": patch
---

summary: Artifact lists now refresh live when new artifacts are registered.
category: fix
dev: TaskStore emits artifact:registered SSE; useArtifacts also accepts message:sent/message:received and coalesces scoped refreshes.
