---
"@runfusion/fusion": patch
---

Persist GitHub tracking `enabled: true` on task records as soon as project/task settings resolve tracking to enabled, even when issue creation is deferred. This keeps API-created tasks aligned with default tracking state in dashboard UI and prevents redundant enabled-state rewrites.
