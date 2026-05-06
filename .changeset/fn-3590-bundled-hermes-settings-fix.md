---
"@runfusion/fusion": patch
---

Fix bundled runtime plugin settings behavior for fresh installs: bundled Hermes/OpenClaw/Paperclip settings now open without a 404 before install, first save still lazy-installs, missing bundles return explicit server errors, and bundled install entry resolution now prefers workspace source entrypoints over stale build artifacts.
