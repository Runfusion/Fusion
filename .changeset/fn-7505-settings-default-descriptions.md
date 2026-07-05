---
"@runfusion/fusion": patch
---

summary: Settings descriptions now show each setting's default value.
category: feature
dev: Appended default-value copy to settings.* i18n descriptions across Global, Runtimes, and Project Settings sections, sourced from DEFAULT_GLOBAL_SETTINGS/DEFAULT_PROJECT_SETTINGS in settings-schema.ts; added settings-default-descriptions.test.tsx guarding that every surfaced setting states a default (or explicit "inherits"/"no default \u2014 unset") and that every DEFAULT_SETTINGS key is documented or allowlisted as not surfaced.
