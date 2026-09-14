---
"@runfusion/fusion": minor
---

summary: Plan Mission with AI now opens in the Missions main content instead of a floating window.
category: feature
dev: `MissionInterviewModal` drops its `FloatingWindow` host and renders an embedded `.mission-interview-panel` section; `MissionManager` swaps the manager body for the interview while it is open in both the inline and overlay hosts. Removes the `floating-window:mission-interview` geometry key, the `mission-interview-modal__drag-handle` drag/resize affordance, and the `useMobileScrollLock` call; `Escape` close is now handled locally by the component.
