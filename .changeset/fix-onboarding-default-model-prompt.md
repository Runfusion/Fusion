---
"@runfusion/fusion": patch
---

summary: Onboarding now offers a default model as soon as a provider connects, instead of staying empty.
category: fix
dev: `availableModels` was fetched at mount and re-fetched only for custom providers, so on a fresh install the Default Model section stayed on "No models available yet. Connect a provider above to see model options." after an OAuth login or API-key save, and no default was ever offered. Both connect paths now refresh the catalogue; once a provider is connected with nothing chosen, the section retitles to "Choose your default model" and scrolls into view once (guarded — JSDOM and non-DOM hosts have no scrollIntoView). Completion is also marked in a `finally` so a failed settings write cannot strand onboarding as unfinished.
