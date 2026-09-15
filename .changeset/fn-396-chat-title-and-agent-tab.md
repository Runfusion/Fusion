---
"@runfusion/fusion": patch
---

summary: Renaming a conversation now updates its window title live, and the chat model picker drops its Agent tab.
category: fix
dev: ChatView gains `onActiveSessionChange`; `usePoppedOutChats` gains `syncSession` and `PoppedOutChatWindows` gains `onSessionSynced`. ChatThinkingLevelControl drops the `showAgentTarget`/`agents` props, the exported `ChatThinkingLevelControlAgent` type, `agentId` from `onChangeModel`, the `chat-thinking-mode-*`/`chat-thinking-agent-*` CSS, and the `chat.newChatModeAgent`, `chat.modelAgentSection`, and `chat.noAgentsAvailable` catalog keys; a bound agent is surfaced read-only through the new `agentName` prop.
