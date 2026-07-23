---
"@runfusion/fusion": patch
---

summary: Fix Compound Engineering sessions dying with "AI returned no valid JSON" when turns race; add retry and diagnostics.
category: fix
dev: CE orchestrator now enforces synchronous single-turn admission per session (concurrent answer/resume gets `CeTurnInProgressError`, HTTP 409) so a re-entered mobile view cannot displace the in-flight turn's live agent. The interactive AI session seam gains a second reformat retry and logs bounded raw-response snippets with provider/model via `interactiveSessionLog` on every parse failure.
