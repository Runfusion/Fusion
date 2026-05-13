---
"@runfusion/fusion": minor
---

Add two global settings for AI thinking-log persistence: `persistAgentThinkingLogPermanent` and `persistAgentThinkingLogEphemeral`. Defaults remain unchanged (thinking persistence is still off unless enabled), and legacy `persistAgentThinkingLog` is retained as a backward-compatible fallback when granular keys are unset.
