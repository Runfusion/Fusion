---
"@runfusion/fusion": patch
---

Tighten dashboard chat prompt guidance so agent replies stay short by default, and route genuinely long-form follow-ups to mailbox via `fn_send_message` (`type: "agent-to-user"`, `to_id: "dashboard"`) without duplicating chat content.
