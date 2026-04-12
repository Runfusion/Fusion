---
"@gsxdsm/fusion": patch
---

Complete agent UI editing parity with Agent Companies manifest fields. This update:

- Adds `memory` and `bundleConfig` fields to the agent create/update API routes
- Fixes Agent Companies manifest parsing to use first-class fields (`title`, `icon`, `role`, `reportsTo`, `instructionBody` maps to `instructionsText`) instead of lossy metadata fallbacks
- Enables identity field editing (name, title, icon, role, reportsTo) in Agent Detail settings
- Adds instruction bundle configuration (mode, entry file, files, external path) to Agent Detail settings
- Adds `memory` field support to New Agent dialog and AI generation mapping
- Updates Agent Import preview to show more manifest fields (icon, reportsTo, instructions snippet)
