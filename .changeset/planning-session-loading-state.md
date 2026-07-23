---
"@runfusion/fusion": patch
---

summary: Planning mode now shows a neutral session loader while restoring a saved session instead of "Generating…".
category: fix
dev: New `session_loading` view state in PlanningModeModal; generating copy, Stop button, elapsed timer, and the missed-SSE watchdog are reserved for sessions the server reports as generating. Unrecognized persisted session shapes land in the retryable error view instead of spinning forever.
