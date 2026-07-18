---
"@runfusion/fusion": patch
---

summary: Fix max_tokens overflow recovery to go directly to session compaction instead of attempting ineffective reduced-max_tokens retry.
category: fix
dev: The reduced-max_tokens retry was removed because session.prompt() ignores the maxTokens option — it never reaches the provider. Compacted prompt memory and prompt section retry steps were also removed as they only compact the prompt text, not the session history. Now on context limit errors, recovery goes directly to compactSessionContext (session.compact()) which reduces the actual input size, then retries with the original parameters.
