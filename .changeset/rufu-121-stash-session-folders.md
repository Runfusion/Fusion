---
"@runfusion/fusion": minor
---

summary: Stash memory sessions are now classified into per-project folders and deleted with their chat.
category: feature
dev: Stash captures carry session_folder_id (get-or-create, external_key fusion-<projectId>, 1h per-process cache); DELETE /api/chat/sessions/:id soft-deletes the matching Stash session best-effort; inert &topic= search param removed from the Stash search URL (MemorySearchOptions.topic remains for qmd/file/readonly backends) and recall queries normalized to single-keyword / explicit-OR ASCII (<=100 chars); event metadata enriched with project/project_name/chat_title. Shared normalizer export for RUFU-120. Per-session delete sync resolves the row via the single-shot by-id lookup (no recent-window residual; RUFU-130).
