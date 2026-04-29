---
"@runfusion/fusion": patch
"runfusion.ai": patch
"@fusion/core": patch
"@fusion/dashboard": patch
"@fusion/desktop": patch
"@fusion/engine": patch
"@fusion/mobile": patch
"@fusion/pi-claude-cli": patch
"@fusion/plugin-sdk": patch
---

Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. *"Step 5/8: Write Tests"*) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
