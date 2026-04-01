---
"@gsxdsm/fusion": patch
---

Add expand/collapse toggle button to QuickEntryBox and InlineCreateCard

- Both quick task creation components now have a manual toggle button (ChevronDown/ChevronUp)
- Components no longer auto-expand on focus - users have control over when to see advanced options
- Expanded state persists until manually toggled or task is submitted/cancelled
- Blur no longer collapses the view - consistent UX across list and board views
- Added CSS styles for collapsed/expanded states and toggle button positioning
