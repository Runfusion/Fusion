---
"@runfusion/fusion": patch
---

summary: Self-heal stale chat "generating" state after restarts and explain empty answers caused by an exhausted output budget.
category: fix
dev: Chat in-flight generation snapshots now record a `startedAt` liveness timestamp; the engine self-healing sweep (startup + maintenance) clears `generating` flags older than 30 minutes, using `startedAt` then `updatedAt` as the age reference and never clearing rows with unparseable timestamps (`chat:stale-in-flight-generation-cleared` / `-no-action` run-audit). Turns ending stopReason "length" with no visible content persist `metadata.budgetExhausted`, and standard chat surfaces render an explicit inline notice (i18n key `chat.outputBudgetExhausted`, all 7 locales).
