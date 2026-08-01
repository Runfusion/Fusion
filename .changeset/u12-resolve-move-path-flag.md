---
"@runfusion/fusion": patch
---

summary: Task moves now validate against the board's own workflow, so cards cannot land in a column it does not declare.
category: fix
dev: Deletes the experimentalFeatures.workflowColumns gate on the move path (6 seams) and its inline legacy branch; column side effects run through default-workflow trait hooks unconditionally. Move rejections now report workflow-resolved targets rather than the legacy adjacency table, which no longer advertises the removed `triage` column. The settings key stays schema-tolerated and hidden for upgraded projects.
