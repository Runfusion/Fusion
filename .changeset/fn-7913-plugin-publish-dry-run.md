---
"@runfusion/fusion": minor
---

summary: Add `fn plugin publish --dry-run` preflight that validates a plugin before publishing.
category: feature
dev: New `runPluginPublish`/`collectPluginPreflight`/`classifyVersionBump` in packages/cli/src/commands/plugin-publish.ts; reuses loadManifestFromPath + resolvePluginEntryFile. Non-mutating; no registry/network calls.
