---
"@fusion/dashboard": patch
---

Don't auto expand the quick add view in list view

Added `autoExpand` prop to QuickEntryBox component to control auto-expand behavior. List view now passes `autoExpand={false}` to keep the interface clean, while board view continues to auto-expand by default.
