---
"@runfusion/fusion": patch
---

summary: Closed GitHub tracked issues now reliably link the landing commit.
category: fix
dev: GitHubTrackingCommentService re-reads the authoritative task via store.getTask before building the Done comment, so mergeDetails.commitSha present at closure time is linked even when the task:moved snapshot omitted it (autoMerge:false PR merges, no-op landings, recovery finalization). Falls back to the event snapshot on refetch failure.
