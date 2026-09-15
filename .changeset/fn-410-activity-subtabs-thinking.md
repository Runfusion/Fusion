---
"@runfusion/fusion": minor
---

summary: Activity views now list vertically, and the Live model icon shows the thinking level used.
category: feature
dev: The vertical-list class moves onto the `[role="menu"]` element rendered by `UiMenu` (`.activity-view-menu-list`), since the portaled surface's column rule never reached the option buttons. `resolvePhaseThinkingLevel` and `ModelThinkingPhase` are re-exported from `packages/core/src/types.ts` for the browser bundle, `effective-model-resolution.ts` gains marker extraction plus lane-precedence resolution, and new `taskChat.thinkingLevelTitle` / `taskChat.thinkingLevels.*` i18n keys cover the seven levels.
