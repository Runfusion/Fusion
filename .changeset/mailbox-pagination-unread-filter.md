---
"@runfusion/fusion": minor
---

summary: Mailbox inbox and sent lists now page past 50 messages with Load more, and the inbox can show unread messages only.
category: feature
dev: `MailboxView` grows its fetch window by `MAILBOX_PAGE_SIZE` (50) and refetches from offset 0 on refresh; the unread toggle uses the existing `unreadOnly` inbox query.
