---
"@dustinbyrne/kb": patch
---

Add missing autoUpdatePrStatus and autoCreatePr fields to ProjectSettings type

Adds two new optional boolean fields to control GitHub PR automation behavior:
- `autoUpdatePrStatus`: When true, automatically poll and update PR status badges
- `autoCreatePr`: When true, automatically create GitHub PRs for completed tasks

Both fields default to false and are included in DEFAULT_PROJECT_SETTINGS.
