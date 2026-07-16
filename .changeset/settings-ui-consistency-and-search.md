---
"@runfusion/fusion": minor
---

summary: Settings search now finds and jumps to individual settings, and settings screens share one type scale.
category: feature
dev: Sections render through the shared `settings/` row primitives (`SettingsToggleRow`/`SelectRow`/`NumberRow`/`TextRow`/`TextareaRow`) instead of hand-rolled `form-group`/`checkbox-label` markup; global `.form-group` is unchanged for the 35 non-settings files that use it. Search is indexed from per-section `<Name>Section.search.ts` entries aggregated in `settings/search/entries.ts`, replacing the hand-curated `searchableText` keyword arrays as the primary match path (keywords remain a fallback for unmigrated sections). `settings-search-index.test.ts` fails the build when a rendered descriptor `key` is missing from the index. Adds the missing `--font-size-sm`/`--font-size-md` tokens plus `2xs`/`lg`, which were referenced by 12 declarations but never defined.
