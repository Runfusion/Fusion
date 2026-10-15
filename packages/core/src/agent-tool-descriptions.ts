/*
FNXC:BoardReadToolDescriptions 2026-10-15-00:01:
RUFU-378: every `fn_task_list` / `fn_task_search` row is built by `formatTaskSummaryLine` from
`task.title?.trim() || deriveTaskLabelFromDescription(task.description, 80)`, so a card with no explicit
title renders a label clamped to the first 80 characters of its raw intake description. That label is the
intake stub, not the plan: two cards whose intake differs past the clamp collapse to one visible prefix,
and a card whose real subject starts after character 80 looks unrelated to itself. Duplicate detection
therefore ran on text that cannot answer the question, and it fails silently — the listing is merely
wrong rather than empty.
Carrying full descriptions on every row is not the fix: that payload is exactly what made board reads
large (RUFU-361/RUFU-378 compaction), and the board already ships only the row it renders. The correction
is in the model-visible tool description instead, so every board-read registration states that the stub is
not the card and names `fn_task_show` — which returns the full description and the PROMPT.md contract — as
the required follow-up before any duplicate, status, or scope judgement.
Keep this value ONE line, double-quoted, and free of `|`: `scripts/sync-fusion-skill-tools.mjs` extracts
only double-quoted literals from the pi registration when regenerating the tracked skill catalog, and
`references/fusion-capabilities.md` renders the description into a Markdown table cell.

FNXC:BoardReadToolDescriptions 2026-10-15-00:44:
RUFU-378 review pass: the sentence names BOTH label branches — the card's title, or the 80-character clamp —
because the clamped branch only fires for a card with no explicit title. Wording that mentioned just the
clamp would be false for every titled row on the board, which is the same class of dishonest model-facing
text this task exists to remove, so the shipped wording is verified against `formatTaskSummaryLine` rather
than against the clamp alone.
*/
export const TASK_BOARD_READ_CAVEAT =
  "Each row shows a one-line label (the card's title, or the first 80 characters of its intake stub), not the card's plan. Call fn_task_show to read a candidate's full description and PROMPT.md before judging duplicates, status, or scope.";
