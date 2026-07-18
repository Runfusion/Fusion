---
"@runfusion/fusion": patch
---

summary: Ship the child-process runtime worker so isolationMode "child-process" works from npm installs.
category: fix
dev: New tsup entry emits dist/child-process-worker.js beside bin.js, matching the engine's getWorkerPath() sibling resolution; bundled with bin.js's noExternal/external/banner shape.
