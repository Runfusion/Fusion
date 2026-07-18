---
"@runfusion/fusion": patch
---

summary: GitHub-import auto-translate now translates issues on every page, not just the first 50.
category: fix
dev: `useGitHubImportAutoTranslate` is now page-scoped, accumulates translations across page navigation, and invalidates per-issue on content change; the per-IP translate budget is raised to fit one full 300-issue fetch-cap traversal per hour.
