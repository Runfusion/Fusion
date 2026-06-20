---
"@runfusion/fusion": patch
---

Stop edits to `scripts/lib/test-quarantine.json` from forcing `pnpm test` into gate mode. The quarantine list is runtime data, not executable test infra; tripping the shared-infra catch-all dropped affected-package coverage, so a dev's real changes went untested whenever they also touched the quarantine list. Quarantine edits now stay in changed mode and run the affected packages.
