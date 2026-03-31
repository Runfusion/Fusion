---
"@dustinbyrne/kb": patch
---

Fix text not being passed into Planning Mode from quick entry

Fixed a stale closure bug in PlanningModeModal where the auto-start useEffect
referenced handleStartPlanning before it was declared. The fix:

1. Moved handleStartPlanning definition before the auto-start useEffect
2. Removed the redundant handleStartPlanningWithPlan callback
3. Modified handleStartPlanning to accept an optional planOverride parameter
4. Fixed the onClick handler to wrap handleStartPlanning in an arrow function
5. Moved hasAutoStartedRef assignment inside setTimeout to prevent early
   triggering that blocked subsequent effect runs

This ensures text entered in QuickEntryBox or InlineCreateCard is properly
passed to the Planning Mode modal when the Plan button is clicked.
