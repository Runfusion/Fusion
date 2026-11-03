---
"@runfusion/fusion": minor
---

summary: Coordination write tools honour a named task_id or refuse one they cannot honour — never write the wrong card.
category: security
dev: `fn_task_log`, `fn_task_document_write`, and `fn_task_document_read` accept an optional `task_id`/`id` target; `fn_task_update`, `fn_task_done`, `fn_task_prompt_write`, `fn_task_file_scope_add`, `fn_review_dispute`, `fn_install_worktree_dependencies`, `fn_run_verification`, and `fn_report_build_failure` reject a foreign target with `cross-card-target` (or `conflicting-targets`/`unsafe-target-id`) and write nothing.
