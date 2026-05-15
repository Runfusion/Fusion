---
"@runfusion/fusion": patch
---

Fix GitHub Copilot OAuth login failing with "OAuth provider did not return state in auth URL" on remote (non-localhost) dashboard hosts. Copilot's device-code flow has no redirect callback, so the dashboard now passes its verification URL through unchanged like it already did for Anthropic and OpenAI Codex. The verification page now opens in a new tab and the device-code panel renders as designed.
