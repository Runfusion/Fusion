---
"@dustinbyrne/kb": patch
---

Group list view tasks by column with section headers

The task list view now displays tasks grouped by their column (triage, todo, in-progress, in-review, done). Each section shows a header with the column's color dot, label, and task count. Empty sections display a "No tasks" placeholder, and when filtering is active, empty sections are hidden. Sorting continues to work within each section, preserving the selected sort order within column groups.