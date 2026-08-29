---
"@runfusion/fusion": patch
---

summary: Fix a Verification gate that reported PASS without running your tests.
category: fix
dev: `GateNodeRunner` recognised only `prompt` and `scriptName` as executable shapes, so a gate carrying `workflowAction` fell through to a silent `return { outcome: "success" }` — deterministic Verification completed in ~46ms and recorded a pass without executing anything, supplying merge evidence for a check that never ran. `verification-gate.ts` now delegates to `runExecutorDeterministicVerification`, the same primitive the in-progress executor gate has always used, instead of re-deriving the command list. Wiring is covered by a differential test that fails when the routing is removed. FN-189 tracks the remaining case where no command is configured at all.
