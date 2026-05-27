---
"@runfusion/fusion": patch
---

Fix the Bun-compiled `fn` executable so `--help` no longer crashes with a missing `react-devtools-core` module. The build now defines `process.env.DEV` as `false` during compile, allowing Ink's DEV-only devtools import path to be removed from the bundled binary.
