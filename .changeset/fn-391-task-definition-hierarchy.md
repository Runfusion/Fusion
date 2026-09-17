---
"@runfusion/fusion": patch
---

summary: Task titles now follow one setting, and Task Detail leads with progress and the expected outcome.
category: feature
dev: Removes the Task Detail title field and its Summarize action; `autoSummarizeTitles` at create time is the only writer of a generated title, and triage no longer copies the `PROMPT.md` heading or backfills a title after a terminal planning failure. `getTaskTitleDisplay` is the single display projection (explicit title, else the description's exact first 220 characters with no ellipsis, else the task ID) across cards, list rows, search, mentions, and every task picker; already-stored titles are untouched and no migration runs. Description editing is narrowed to manual-intake columns via the new `isDescriptionEditableColumnRole`, while other pre-implementation settings stay editable. Definition renders progress (step list collapsed behind an `aria-expanded` disclosure), a height-bounded scrollable description, then a product-language summary selected by `extractTaskProductSummary` from `## What This Delivers` (falling back to `## Before → After Transformation`, never `## Mission`); `Read plan` still opens the complete `PROMPT.md`. Setting `autoSummarizeTitles` keeps its `false` default and the `POST /api/ai/summarize-title` endpoint remains an integration contract.
