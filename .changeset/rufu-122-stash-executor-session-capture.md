---
"@runfusion/fusion": minor
---

summary: Finished or failed tasks now upload their executor transcript (agent-log.jsonl) to Stash as a task session.
category: feature
dev: On task terminalization (done, or failed/parked), the engine uploads the per-task agent-log.jsonl to Stash session fusion-task-<taskId> in log order, alongside the existing task_completion/task_failure anchor event. Text runs merge into one assistant_message; tool/tool_result/tool_error map 1:1 (errors prefixed "ERROR: "); status entries only when executorSessionCaptureIncludeStatus is on; every event is capped at 4000 chars and carries {taskId, status, line, project, project_name}. Uploads chunk at the verified 100-event batch cap, stop at the first failed chunk, and never block terminalization. New project settings: executorSessionCaptureEnabled (default on; off = anchor event only), executorSessionCaptureMaxEvents (default 20000, most recent kept), executorSessionCaptureIncludeStatus (default off, schema-only — no UI row). Stash backend only; respects memoryEnabled=false; once-per-task gate spans the complete and terminal-failure seams. Settings UI: Memory section toggle + max-events number row (stash backend only, disabled-not-hidden when memory is off).
