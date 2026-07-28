---
"@runfusion/fusion": patch
---

summary: Stop duplicate tasks re-planning in a loop instead of asking you to keep or delete them.
category: fix
dev: The planning prompt told the planner "do not write PROMPT.md" and "write DUPLICATE: <id> to the output file" — the output file being PROMPT.md. Planners resolved the contradiction by writing no file and reporting the duplicate in prose, which the engine cannot see (`parseExplicitDuplicateMarker` reads PROMPT.md's contents). The task then failed deterministic validation as "PROMPT.md not found or empty", retried, terminalized, sent a task-wedge mail, self-healed back to todo, and re-planned indefinitely — never setting `sourceMetadata.nearDuplicateOf`, which is what renders the operator's keep/delete decision. Both prompt sites now state that the file must be written with the marker as its entire contents.
