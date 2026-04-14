---
"@gsxdsm/fusion": patch
"@fusion/core": patch
"@fusion/dashboard": patch
---

Add `openrouterModelSync` setting (default: true) to control whether the dashboard fetches the latest OpenRouter model catalog at startup. Toggled in Settings → Models. This fixes the model picker not showing the latest OpenRouter models because the `pi-openrouter-realtime` extension only syncs on `session_start` events (TUI-only).
