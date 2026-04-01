---
"@gsxdsm/fusion": patch
---

Increase test speed by optimizing backup tests with fake timers and enabling parallel file execution across all packages.

- Refactored backup tests to use `vi.useFakeTimers()` and `vi.setSystemTime()` instead of real 1100ms delays
- Core package tests now run with `fileParallelism: true` (reduced from ~30s to ~3s)
- Enabled parallel execution in engine, CLI, and dashboard packages
- All backup tests now complete in <200ms instead of ~24s
