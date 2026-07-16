---
"@runfusion/fusion": minor
---

summary: Dashboard keyboard shortcuts now toggle — re-press a shortcut to close its interface.
category: feature
dev: Shortcut handlers in useDashboardKeyboardShortcuts + App.tsx now dispatch toggle callbacks (open on first press, close/revert on re-press). Modal-backed shortcuts use existing nav-aware closers; view-backed shortcuts (Settings/Command Center) retain the exact revert callback pushed by handleTaskViewChange, removeNav it, and restore the captured prior view (not board), so both shortcut-opened and UI-opened views close without leaking a browser-back entry.
