---
"@runfusion/fusion": patch
---

summary: GitHub and GitLab issue panels now count resolved issues on renamed boards.
category: fix
dev: `aggregateGithubIssueAnalytics` and `aggregateGitlabIssueAnalytics` take an optional lane store and resolve the complete columns via `resolveProjectColumnsForRoles`; their resolved-issue queries previously filtered on the literal `'done'`.
