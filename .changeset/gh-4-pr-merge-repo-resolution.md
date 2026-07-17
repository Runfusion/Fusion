---
"@runfusion/fusion": patch
---

summary: Fix PR-mode auto-merge failing with "Could not determine repository" in centrally-installed multi-project deployments.
category: fix
dev: processPullRequestMergeTask, createGroupPrCallback, and createPrNodeGithubOps now pass explicit owner/repo (resolved from the per-project cwd / task worktree) into findPrForBranch/createPr/mergePr instead of relying on GitHubClient.resolveRepo's process.cwd() fallback; the engine's buildRespondCallback resolves the review-response run cwd from the task's recorded worktree. Fixes Tchori-Labs/Fusion#4; non-workspace sibling of upstream #1924/FN-7610.
