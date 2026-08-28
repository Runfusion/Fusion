---
"@runfusion/fusion": patch
---

summary: A blocking review gate no longer approves when the reviewer never returned a usable verdict.
category: fix
dev: Restores FN-6582's blocking-gate rule, reversing the later relaxation that treated malformed gate output as a non-blocking advisory. `executeWorkflowStep` already restarts cleanly twice on malformed output (fallback-model retry, or a self-retry on the primary when no fallback is configured), so `malformed` reaching the graph decision means the reviewer failed across every attempt — the LLM-class condition an operator accepts as a legitimate stop, and never grounds to record approval. Measured cost of the relaxation: a reviewer reported in prose that the deliverables were absent, carried no verdict JSON, and the gate recorded success, merging unreviewed work on a rejection nobody could see. A prose classifier cannot close this — that text contained no rejection marker at all — so only the absence of a verdict is detectable and absence must not approve. Advisory gates keep the relaxation: a step that was never allowed to hold a card does not start holding one. `runGraphCustomNode` now maps `success || (!blocking && verdict !== "UNAVAILABLE")`, and the malformed→block assertion the relaxation deleted is restored.
