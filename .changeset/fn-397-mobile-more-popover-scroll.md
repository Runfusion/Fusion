---
"@runfusion/fusion": patch
---

summary: Mobile navigation menu keeps its scroll position, so a tapped entry opens instead of jumping to the top.
category: fix
dev: The popover's opening focus now runs once per open with `focus({ preventScroll: true })`, and `useNavigationHistory` memoizes its result so the `NavigationHistoryContext` value is referentially stable across App renders.
