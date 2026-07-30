---
"@runfusion/fusion": patch
---

summary: Report how an implementation session ended on the code path the engine actually runs.
category: fix
dev: `createDefaultNodeHandlers` prefers `createPrimitivePromptLikeHandler` whenever `deps.primitives` is set, and `executeWorkflowGraph` always sets it — so `createAuthoritativeWorkflowSeams.execute` is unreachable for prompt nodes. The `NodeCompleted.exit` announcement was wired only there and never fired; it now emits from `runCodingSession`. Adds a ratchet asserting the primitives-preferred dispatch rule.
