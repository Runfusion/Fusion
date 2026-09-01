---
"@runfusion/fusion": patch
---

summary: A card sent back for review fixes no longer gets permanently stuck unable to start them.
category: fix
dev: `evaluateStepLedgerSeal` now skips its own "Ignored post-completion …" narration, which quoted the completion marker verbatim and therefore re-sealed on a substring match — each refusal nesting inside the last, so no re-entry marker could ever lift it. Also adds the graph resume wording "Resuming execution after unpause" to the re-entry markers; only `run-implementation.ts`'s "Resumed agent session after unpause" was listed, so one of the two documented resume paths never lifted the seal.
