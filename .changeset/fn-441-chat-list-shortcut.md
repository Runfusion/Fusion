---
"@runfusion/fusion": minor
---

summary: Add a configurable keyboard shortcut that opens the chat list.
category: feature
dev: New `openChatList` dashboard shortcut action (global default `Ctrl+Shift+L`) declared in `DashboardKeyboardShortcuts`. It toggles the existing host resolved from the measured viewport mode — the `chat` view drawer on mobile, the footer `chat` tool popover anchored on `desktop-nav-chat-panel` otherwise — via `resolveChatListShortcutTarget`/`readShortcutAnchorRect`.
