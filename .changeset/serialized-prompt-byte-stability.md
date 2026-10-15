---
"@runfusion/fusion": patch
---

summary: AI lanes now keep the system prompt byte-stable so model prefix caching actually hits.
category: performance
dev: Runtime-mutable prompt state (retrieved memory, live goal rows, rating summaries, per-card identity/policy, per-turn recall, chat `@`-mention cards) moved from the serialized system prompt to a "## Session Context" block appended to each request; `buildPromptLayers` inputs are config-time only, and the planning lane resolves planner instructions through the parts API so an agent's memory and rating bytes never enter the head. New blocking `scripts/check-prompt-volatility.mjs` gate rejects volatile creep, including a collapsed instruction producer reaching any `*PromptLayers` / `*SystemPrompt` / `*PromptContext` head slot; verify with `pnpm check:prompt-volatility` and `docs/solutions/performance/serialized-prompt-byte-stability-runbook.md`.
