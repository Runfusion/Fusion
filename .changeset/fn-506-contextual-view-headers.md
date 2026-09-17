---
"@runfusion/fusion": patch
---

summary: Contextual Chat, Notes, and Mailbox headers with a quick-actions menu for the open item.
category: fix
dev: Mailbox's `mailbox-unread-badge` now requires `!showComposer && activeTab === "inbox"` in both MailboxView and MailboxModal. ChatView's header renders `chat-header-actions-btn` instead of `chat-new-btn` when a resolved conversation is shown (non-dedicated, non-listOnly), reusing the existing `.chat-session-context-menu` with a `source: "header"` marker that adds `chat-context-new-chat`. NotesView uses the newly public `ListItemContextMenuController.openAt` to open the shared `ListItemContextMenu` from the header (`notes-menu-new`/`rename`/`delete`); header rename returns to the list first when the list rail is hidden.
