---
"@runfusion/fusion": minor
---

summary: Add Cheaper Inference as a named model provider with startup catalog sync.
category: feature
dev: Syncs the Cheaper Inference `/v1/models` catalog at startup when a key is stored and again when a key is saved (gated by `cheaperinferenceModelSync`, 15s request timeout), registers an `openai-completions` provider at `https://api.cheaperinference.com/v1` with the `CHEAPER_INFERENCE_API_KEY` key reference (text models only), and surfaces Cheaper Inference across the auth catalog, onboarding quick-start, provider icons, and settings.
