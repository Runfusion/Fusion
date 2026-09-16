---
"@runfusion/fusion": patch
---

summary: Footer settings button now sits in the far-left corner, with the concurrency counter beside it.
category: fix
dev: `EngineControlMenu` gains an additive optional `triggerClassName` that replaces only the base class; `DesktopActionBar` passes `desktop-action-bar__action` so the capacity trigger reuses the shared footer action paint instead of `.btn`.
