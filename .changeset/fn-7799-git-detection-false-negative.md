---
"@runfusion/fusion": patch
---

summary: Fix a false "Project directory is not a Git repository" error that blocked all task execution in valid repos.
category: fix
dev: Git detection is now tri-state (repo/not-repo/error) via detectGitRepository(); dubious-ownership/PATH/timeout git failures no longer masquerade as "not a Git repository". FN-7799.
