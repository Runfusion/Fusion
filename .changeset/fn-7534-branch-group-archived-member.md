---
"@runfusion/fusion": patch
---

summary: Branch groups no longer report complete (or become promotable) when an unlanded member is archived.
category: fix
dev: listTasksByBranchGroup membership now scans with includeArchived:true so an archived-but-unlanded member stays counted in total instead of silently dropping out; mergeDetails is now persisted on ArchivedTaskEntry so an archived member that had already landed keeps counting as landed. evaluateBranchGroupCompletion / promoteBranchGroup gate correctly; merge-target-safety in isBranchGroupMemberLanded is unchanged.
