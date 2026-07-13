---
"@runfusion/fusion": patch
---
summary: Fix post-insert task rollback and add GitLab tracking reconcile.
category: fix
dev: Adds a catch/cleanup around `_createTaskInternalBackendImpl` post-insert filesystem work so a writeTaskJsonFile or prompt-validation failure soft-deletes the inserted row (FN-7074 invariant). Adds `listTasksForGitlabTrackingReconcile` TaskStore facade mirroring the GitHub counterpart.
