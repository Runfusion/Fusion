---
"@runfusion/fusion": patch
---

summary: Retain GitHub issue import state when leaving and returning to Import Tasks.
category: fix
dev: Persists GitHubImportModal provider/tab/label filter/remote/selection per project via projectStorage (`kb-dashboard-github-import-state`) and hydrates on remount; falls back to the existing default-remote auto-detect when nothing is persisted.
