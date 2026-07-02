---
"@runfusion/fusion": patch
---

summary: Fix the Windows CLI binary failing to build in release.
category: fix
dev: The bun `--conditions=source` compile of the CLI could not resolve @fusion-plugin-examples/hermes-runtime and openclaw-runtime (statically imported by dashboard routes.ts) because those plugin packages lacked a `source` export condition and fell through to `import`→`dist/index.js`, which is absent on the Windows runner. Added `"source": "./src/index.ts"` to both plugins' exports (matching @fusion/core|dashboard|engine|plugin-sdk) so bun bundles their TS source directly, independent of dist. Verified locally by cross-compiling bun-windows-x64 with plugin dist removed; a negative control reproduced the exact "Could not resolve" error.
