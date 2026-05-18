---
"@runfusion/fusion": minor
---

Fusion now includes a redesigned pull request creation flow with AI-generated title/description suggestions and support for repository PR templates. You can open PR creation from new dashboard entry points (task detail header, task card quick action, in-review prompt, and merge/review modal) or from the CLI with `fn pr create`. A new PR status panel shows live checks and review comments, supports merging from the dashboard, and can optionally enable auto-merge when checks are green. When a PR merges, the task auto-transitions to done; if reviewers request changes, the task is routed back to todo with that feedback visible in Fusion.
