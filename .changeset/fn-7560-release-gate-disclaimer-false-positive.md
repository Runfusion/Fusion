---
"@runfusion/fusion": patch
---

summary: Stop the release-authorization gate from holding tasks that merely disclaim releasing.
category: fix
dev: classifyReleaseTask now strips negated release-disclaimer clauses (e.g. "this task performs no release/publish; releases are owned by scripts/release.mjs") before signal matching in packages/engine/src/triage-release-authorization.ts, so revert/undo/UI specs are no longer false-flagged as release-class. Genuine "run pnpm release"/"publish @runfusion/fusion" intent still trips the gate.
