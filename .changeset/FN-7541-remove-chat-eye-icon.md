---
"@runfusion/fusion": patch
---

summary: Remove the eye icon markdown/plain toggle from chat; messages always render as Markdown.
category: breaking
dev: Removed ChatView `chat-thread-header-render-toggle` (desktop + mobile), `showAllAsPlain` state, and `chat.showRenderedMarkdown`/`chat.showPlainText` i18n keys (FN-7541).
