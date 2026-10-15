---
"@runfusion/fusion": patch
---

summary: Chat overflow errors now name the real compaction reason and retry one transient failure aggressively.
category: fix
dev: "`compactSessionContext` returns a discriminated `CompactionOutcome` union (reason + `branchMutated`); `ChatContextOverflowError` carries a `ChatContextOverflowReason` code; the gate escalates to a second compaction pass exactly once (only when the branch is unmutated) and emits one bounded `chat:pre-overflow-compaction` run-audit row per attempt. A pi version bump that rewords a refusal literal trips `packages/engine/src/__tests__/pi-compaction-contract.test.ts`."
