---
"@runfusion/fusion": patch
---

summary: Terminals, planning sessions, and popped-out task windows no longer reset when switching views or tabs.
category: fix
dev: Keep-alive layer (KeepAliveView, visibility-based out-of-flow hiding) for Planning Mode, task-detail terminal/planner-chat tabs, and popped-out task FloatingWindows; hidden surfaces suspend SSE/EventSource work via `active` props. Stable keys for streaming chat segments, dock task cards, and MCP server rows. CommandCenter/DevServerView selections persist per project via modalPersistence.
