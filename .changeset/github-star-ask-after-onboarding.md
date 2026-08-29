---
"@runfusion/fusion": minor
---

summary: Ask once to star Fusion on GitHub after onboarding finishes, and never again if dismissed.
category: feature
dev: New global setting `githubStarPromptDismissedAt` is stamped on either answer; the ask is skipped on the non-interactive auto-launch path and on `fn onboard --force` once answered.
