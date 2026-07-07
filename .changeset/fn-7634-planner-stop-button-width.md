---
"@runfusion/fusion": patch
---

summary: Fix the task-detail Planner Chat stop button rendering narrower than its send button.
category: fix
dev: `TaskPlannerChatTab.css` now declares a locally-scoped `--chat-input-control-size` on `.task-planner-chat-composer` (same formula as `ChatView.css`'s `.chat-input-row`) and applies it as a `min-inline-size` floor on `.task-planner-chat-send`, so the shared `.chat-input-send`/`.chat-input-stop` classes (which previously read an undefined custom property inside the Planner composer and fell back to `width: auto`) never render the streaming Stop button narrower than the idle Send button on desktop or mobile.
