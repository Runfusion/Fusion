---
"@runfusion/fusion": patch
---

summary: Restore an archived card to the lane it was archived from, not to Done.
category: fix
dev: `preArchiveColumn` was never captured — it has no `project.tasks` column and lives only in the archive snapshot — so `unarchiveTaskImpl` always fell to its `?? "todo"` literal. On a custom workflow `todo` is undeclared, so the destination resolver took its no-usable-history branch and returned the complete lane. Captures the column into the snapshot on archive and reads the snapshot (not the restored row) on unarchive; both halves are required.
