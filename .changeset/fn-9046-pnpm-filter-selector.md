---
"@runfusion/fusion": patch
---

summary: Merge verification now runs tests for packages depending on a changed package.
category: fix
dev: `deriveScopedPnpmTestCommand` now uses `...<pkg>` instead of malformed `<pkg>...^` selectors.
