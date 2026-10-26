---
"@runfusion/fusion": minor
---

summary: Add Requesty as a named model provider with startup catalog sync.
category: feature
dev: Syncs the Requesty `/v1/models/managed` policies and `/v1/models` catalog at startup (gated by `requestyModelSync`), registers an `openai-completions` provider at `https://router.requesty.ai/v1` resolving its key from `REQUESTY_API_KEY`, and surfaces Requesty across the auth catalog, onboarding quick-start, provider icons, and settings.
