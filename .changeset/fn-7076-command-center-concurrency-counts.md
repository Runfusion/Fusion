---
"@runfusion/fusion": minor
---

summary: Command Center Concurrency now shows running agents and current-use markers on global/project sliders.
category: feature
dev: CommandCenterControls reuses useGlobalConcurrency's currentlyActive/projectsActive (FN-7071) to render count readouts and clamped slider-track dots; no new backend routes.
