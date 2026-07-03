---
"@runfusion/fusion": patch
---

summary: Add `electron` as a runtime dependency so `fusion desktop` works from a published npm install.
category: fix
dev: `packages/cli/package.json` now depends on `electron`. Previously the desktop launcher called `require("electron")`, which is only available inside the source checkout (via `pnpm-workspace.yaml` `onlyBuiltDependencies`) and is missing for npm consumers, causing `fusion desktop` to hang or fail silently.
