---
"@runfusion/fusion": minor
---

summary: Truncated chat replies now show an inline notice naming what the engine dropped, instead of a silent context loss.
category: feature
dev: Dashboard half of RUFU-183 — depends on the engine tier PR. Rescued assistant messages persist `metadata.contextTruncation`, and every chat surface (ChatView direct/room, task Planner Chat) renders an inline notice naming the dropped message/token counts, with an explicit unverified variant when re-measurement was unavailable. Also wires the two settings keys this stack introduces: the dashboard gate passes `chatPreOverflowCompactionEnabled` into `ensureContextWithinCompactionThreshold` (disabled: zero session writes, zero audit rows) and honours `chatContextBudgetEnabled` when building prompts, with the toggles rendered in the Memory settings section.
