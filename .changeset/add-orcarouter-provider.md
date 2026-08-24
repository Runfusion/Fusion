---
"@runfusion/fusion": minor
---

summary: Add OrcaRouter as a named model provider with startup catalog sync.
category: feature
dev: Syncs the OrcaRouter `/v1/models` catalog at startup (gated by `orcarouterModelSync`), registers an `openai-completions` provider at `https://api.orcarouter.ai/v1` resolving its key from `ORCAROUTER_API_KEY`, and surfaces OrcaRouter across the auth catalog, onboarding quick-start, provider icons, and settings.
