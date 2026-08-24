---
"@runfusion/fusion": minor
---

summary: Make workspace tasks use one scoped directory with safer merge and sandbox gates.
category: fix
dev: Replaces coordinatorWorktreePath and remediationRepository cwd routing with task-directory boundaries; adds kinded boundary declarations, sandbox delegation for bash/streaming/configured commands, merge-door requiredPreMergeStepIds with resultless bypass parity, and a legacy-layout compatibility fork.
