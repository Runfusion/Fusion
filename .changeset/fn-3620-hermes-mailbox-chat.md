---
"@runfusion/fusion": patch
---

Fix dashboard agent chat sessions so plugin runtimes (including Hermes) receive Fusion mailbox tools when a message store is available, enabling real `fn_send_message`/`fn_read_messages` usage with correct agent-to-dashboard recipient routing semantics.
