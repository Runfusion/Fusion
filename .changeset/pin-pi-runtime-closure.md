---
"@runfusion/fusion": patch
---

summary: Fix `fn` crashing on startup after a fresh npm install due to a mismatched Pi codemode package.
category: fix
dev: The published manifest now pins the full `@earendil-works/*` Pi runtime closure exactly; npm had resolved `pi-codemode@1.4.0` beside `pi-coding-agent@1.1.0`. `check-pi-versions-pinned` now requires every closure member in `packages/cli/package.json`.
