---
"@runfusion/fusion": minor
---

Saving an opencode or opencode-go API key from the dashboard now immediately refreshes the opencode-go model catalog (no restart required), reports how many models were registered, and surfaces actionable errors when the local `opencode` CLI is missing or returns no models. `opencode-go` is now always listed as an API-key target in Settings, even before models are registered.
