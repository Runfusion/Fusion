---
"@runfusion/fusion": patch
---

summary: Keep expanded Mailbox reply-context rows open when another row is expanded.
category: fix
dev: `ReplyContextExpandable` was declared inside `MailboxModal`'s render, so every parent update produced a new element type and remounted the recursive reply thread, collapsing already-expanded rows. Hoisted to module scope with an explicit `env` prop.
