---
"@dustinbyrne/kb": minor
---

Add completion summary section to task Definition tab

- Added `summary` field to Task type for storing completion summaries
- Updated executor system prompt to guide AI in generating completion summaries
- Modified `task_done()` tool to accept optional summary parameter
- Added Summary section to Definition tab for done tasks with visual styling
- Summary is displayed with markdown rendering and success-colored accents
- All existing tests pass; added new tests for summary functionality
