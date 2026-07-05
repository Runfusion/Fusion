---
"@runfusion/fusion": minor
---

summary: Fusion self-repo issue-close comments now show current and target release versions.
category: feature
dev: GitHubIssueCommentService appends "Current version: v{current}" and "Target release: v{next-minor}" lines when the linked source issue is runfusion/fusion; other repos unchanged. Version resolved via getCliPackageVersion.
