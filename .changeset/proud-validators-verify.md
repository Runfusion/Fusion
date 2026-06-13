---
"@runfusion/fusion": minor
---

Close the validator reaper→slice deadlock and harden every validation re-drive site for the new behavioral-verification posture. A reaped, task-less "done" feature (left in `loopState="validating"`/`needs_fix`+`error`) is now re-driven by recovery to a terminal pass/fail/inconclusive verdict instead of livelocking the slice, milestone, and mission. Adds an adversarial reliability suite enumerating every re-drive entry point (normal `processTaskOutcome`, each `recoverActiveMissions` branch, and the stale-run reaper) and asserting source-tree git-cleanliness, zero duplicate Fix Features, a terminal verdict, and no `error`-state deadlock. Documents the non-mutating verification run, the first-class `inconclusive` verdict, and the adversarial default-to-fail posture across `docs/missions.md`, `docs/missions-completion-contract.md`, and `CONCEPTS.md`.
