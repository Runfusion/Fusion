---
"@runfusion/fusion": minor
---

summary: Mailbox messages now always show an author and a readable subject line.
category: feature
dev: Adds optional `MessageMetadata.subject` (validated, max 200 chars) and the shared dashboard resolver `resolveMailboxMessageSubject`, used by MailboxView, MailboxModal, and the AgentDetailView Mail tab; legacy mail derives a subject from its kind, report title, or body.
