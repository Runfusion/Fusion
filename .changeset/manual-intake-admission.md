---
"@runfusion/fusion": patch
---

summary: Cards parked in the Coding (Ideas) intake are no longer auto-planned by the engine.
category: fix
dev: Triage discovery reads the intake trait's `autoTriage: false` from the same IR resolution and skips manual-intake columns; the hold branch is intentionally ungated. The pre-existing guard in `triage.test.ts` could not catch the regression because its mock store cannot resolve a workflow.
