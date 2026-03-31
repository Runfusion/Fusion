---
"@dustinbyrne/kb": patch
---

Reposition QuickEntryBox in ListView to appear directly above table headers

The QuickEntryBox component has been moved from its previous position
(between the toolbar and column drop zones) to a new location directly
above the table headers. This creates a more logical visual flow:
toolbar → filters → drop zones → quick entry → table headers → task rows.
