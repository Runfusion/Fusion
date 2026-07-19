---
"@runfusion/fusion": patch
---

summary: Boards built on custom workflows now show and move cards in their own columns.
category: fix
dev: Operator surfaces closed the column set in four places. The dashboard ran every ingested task through `normalizeColumn`, which keeps only the six legacy ids and rewrote everything else to `triage`, so a card in a user-authored column rendered in Triage (new `normalizeColumnId` sanitizes structurally instead). `POST /tasks/:id/move` validated against the `COLUMNS` enum and answered 400 for any workflow-defined column; it now validates against the task's resolved IR and keys worktree allocation on the `wip` trait. Retry / reset / re-engage / unassign / spec-revise moved cards with hardcoded `"todo"`/`"in-progress"`/`"triage"` targets and gated spec revision on `VALID_TRANSITIONS`, all now derived from the task's workflow by trait. GitHub issue open/closed mapping keys on the `complete`/`archived` traits via an injected classifier whose default reproduces the legacy literal mapping. Status badges prefer the running workflow step's IR-declared name over raw engine status tokens.
