---
"@runfusion/fusion": patch
---

summary: Fix Anthropic subscription login when pasted callback URLs contain fragment OAuth parameters.
category: fix
dev: Normalizes pasted OAuth callback fragments before resolving dashboard manual-code login prompts.
