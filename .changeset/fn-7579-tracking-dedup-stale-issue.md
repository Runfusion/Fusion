---
"@runfusion/fusion": patch
---

summary: Stop GitHub tracking-issue creation from linking new tasks to old/closed issues.
category: fix
dev: github-tracking dedup now only reuses OPEN issues and requires a File-Scope path overlap (keyword-only matches no longer link). Prevents mis-linking a fresh task to a stale/resolved tracking issue (FN-7579). Setting `githubTrackingDedupEnabled` unchanged.
