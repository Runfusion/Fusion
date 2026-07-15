/*
FNXC:GitHubImportTranslate 2026-07-15-09:30:
Detection moved to `@fusion/core` (detect-content-language.ts) so the dashboard and the server-side auto-translate run share ONE heuristic and can never disagree about whether an issue needs translating.
This module stays as a re-export: existing component imports and the util's test suite keep their import path, and the move stays a pure relocation rather than a call-site churn.
Imported via the `@fusion/core/detect-content-language` SUBPATH, not the package root: the browser bundle aliases `@fusion/core` to the leaf `types.ts`, so a root import would not resolve at build time even though it typechecks.
*/

export {
  MIN_DETECTABLE_CHARS,
  detectContentLanguage,
  contentNeedsTranslation,
  localeDisplayName,
} from "@fusion/core/detect-content-language";
export type { LanguageFamily, DetectedContentLanguage } from "@fusion/core/detect-content-language";
