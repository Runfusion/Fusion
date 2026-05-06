---
"@runfusion/fusion": patch
---

Expose task creator provenance in agent-facing task tools by adding source summaries to `fn_task_show` and concise `[via: …]` labels in `fn_task_list`, including agent-name preference from `sourceMetadata.agentName` with `sourceAgentId` fallback.
