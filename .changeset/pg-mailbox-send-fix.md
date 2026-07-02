---
"@runfusion/fusion": patch
---

summary: Mailbox — sending a message to an agent works in PG mode instead of erroring.
category: fix
dev: POST /api/messages to an agent 500'd in embedded-PG mode: MessageStore.sendMessage persisted the message via the async layer, then synchronously invoked the agent-delivery hook (agent-heartbeat.handleMessageToAgent), which reads the not-yet-ported sync AgentStore and throws. The persisted send must not fail on a notification side-effect, so the onMessageToAgent hook call is now wrapped — a hook failure logs and degrades (agent wake-on-message stays disabled in PG mode until AgentStore is ported) instead of failing the send. Adds message-store.pg.test.ts to test:pg-gate.
