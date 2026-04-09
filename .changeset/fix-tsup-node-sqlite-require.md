---
"@gsxdsm/fusion": patch
---

Fix tsup bundle runtime issues by preserving node: prefix in imports and injecting require shim. The CLI bundle now runs directly with `node dist/bin.js --help` without requiring Docker-specific shims or post-build patches for node:sqlite imports or ESM require() helpers.
