---
"@runfusion/fusion": patch
---

Test bootstrap (`scripts/ensure-test-artifacts.mjs`) now detects STALE example-plugin
dist artifacts (`@fusion-plugin-examples/{hermes-runtime,openclaw-runtime,paperclip-runtime}`)
in addition to missing ones by comparing `src/` mtimes against the oldest `dist/`
entry artifact. When a rebuild fails, the script emits an actionable remediation
block (FN-4232) before exiting non-zero so worktree and merger-verification flows
no longer fail first with opaque Vite "Failed to resolve entry for package" errors.
