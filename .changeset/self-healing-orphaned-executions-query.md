---
"@runfusion/fusion": patch
---

summary: The orphaned-execution signal is now emitted on boards with renamed columns.
category: fix
dev: `recoverOrphanedExecutions` read the literal `in-progress`, so on a renamed board it never emitted `task:orphan-detected-no-action` and an operator had no signal that a wip card had no live session. The sweep takes no lifecycle action; this restores visibility only. Read resolves via `resolveProjectColumnsForRoles`, per-card check resolves per card.
