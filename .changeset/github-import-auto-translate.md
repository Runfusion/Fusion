---
"@runfusion/fusion": minor
---

summary: Auto-translate foreign-language GitHub issues in the Import Tasks panel, with a target language and model you choose.
category: feature
dev: New project settings `githubImportAutoTranslate` (default false) and `importTranslateTargetLocale`, plus an `import-translate` model lane (project `importTranslateProvider`/`importTranslateModelId`, global `importTranslateGlobalProvider`/`importTranslateGlobalModelId`) resolved by `resolveImportTranslateSettingsModel`. Translations persist in the new `project.import_translation_cache` table (migration 0010) keyed by project+repo+issue+locale+source hash, and are pruned when an issue closes. `POST /api/github/issues/auto-translate` translates the 50 most recent open foreign issues per load on its own rate-limit budget; both single and batch import read the cache so imported tasks carry the translated title/body. Language detection moved from the dashboard app to `@fusion/core` so the panel and server share one heuristic.
