---
"@runfusion/fusion": patch
---

summary: A card sent back for review fixes can now actually start them instead of stalling on the first step.
category: fix
dev: `appendRemediationStepsImpl` now stamps the step-ledger reopen marker inside its atomic mutation when the log tail carries a clean-completion marker. `evaluateStepLedgerSeal` refuses step transitions after completion until a re-entry marker supersedes it, and `updateStep` wrote that marker only for a pending reset or operator edit — remediation arrives through the append path, so the seal survived and the new Fix step was refused as a post-completion projection.
