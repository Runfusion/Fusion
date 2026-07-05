---
"@runfusion/fusion": minor
---

summary: Add "Ask user question" and "Exit gate" workflow nodes for mid-flow chat reach-out and early exit.
category: feature
dev: New IR node kinds `ask-user` (reuses await-input park/resume; surfaces the question in the task chat) and `exit-gate` (terminates the workflow early, optional condition). Editor palette + summaries + help updated; `prompt`+`awaitInput` remains a back-compat alias.
