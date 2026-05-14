---
"@runfusion/fusion": patch
---

Fix stale "files changed / insertions / deletions" on done tasks when `pushAfterMerge` is enabled. After `pushToRemoteAfterMerge` rebases HEAD, the merger now re-reads `git show --shortstat <postPushSha>` and rewrites `mergeDetails.filesChanged/insertions/deletions` alongside the refreshed `commitSha` (previously only the SHA was updated, leaving pre-rebase squash stats attached to the post-rebase commit). The `recoverDoneTaskMergeMetadata` self-healing pass also now detects and repairs stored stats that disagree with the live commit at the stored SHA, both at startup and during periodic maintenance.
