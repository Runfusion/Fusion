---
"@runfusion/fusion": patch
---

summary: Vanished-work alerts no longer fire for cards that were deleted on purpose.
category: fix
dev: The `reconcile-vanished-task-dirs` ladder now consults row evidence before branch evidence, so a soft-delete tombstone whose `fusion/<id>` branch is gone reports the new `row-tombstoned-branch-unprobed` reason and `state-unresolved` is reserved for an id no table holds (measured: 891 `state-unresolved` rows over 229 cards in 3 h, 211 of them present as tombstones, because soft deletion stamps the `archived` sentinel with `deletedAt` by design). The run-audit row remains unconditional for every finding; only the mailbox notice is gated (`vanishedFindingRequiresOperatorNotice`) to proven unmerged work or a row that exists nowhere, replacing ~700 notices/day (15,101 system messages since 2026-09-24) with the 11 cards that had unmerged commits and the 18 that have no row. No lifecycle move, no data repair, nothing suppressed from the audit store.
