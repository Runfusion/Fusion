---
"@gsxdsm/fusion": patch
---

Fix agent picker showing stale agents when switching between projects in QuickEntryBox and InlineCreateCard. The picker now clears cached agents when projectId changes, ensuring fresh agent data is always fetched for the current project context.
