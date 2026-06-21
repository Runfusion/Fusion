---
"@runfusion/fusion": patch
---

Keep Fusion verification progress moving by making targeted script tests honor file arguments, reaping verification subprocess groups after clean exits, and preventing the line-count audit from blocking `pnpm test`. The changed-test runner now caps reverse-dependent fan-out so a foundational-package edit no longer expands into a whole-workspace run, and the executor/verification guidance now directs agents to scope verification to changed files rather than running the full workspace test suite.
