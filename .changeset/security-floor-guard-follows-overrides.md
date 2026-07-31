---
"@runfusion/fusion": patch
---

summary: Internal test fix; no user-visible change.
category: internal
dev: The protobufjs security-floor assertion now reads `pnpm-workspace.yaml`, where #2220 moved pnpm overrides, instead of the empty `package.json` block.
