---
"@runfusion/fusion": minor
---

summary: Mailbox now has two tabs, a contextual header filter, and real-time lists with no refresh button.
category: feature
dev: `MailboxTab` is reduced to `inbox`/`outbox` in MailboxView and MailboxModal; archived/approvals/agents/completions become inbox scopes behind `mailbox-inbox-filter` (UiButton + UiMenu, `role="menuitemradio"`); the `mailbox-approvals-pending-badge` keeps its single render point, relocated onto the filter trigger; the `mailbox-refresh` testid and `mailbox.refreshTitle` key are removed; `onMailboxUpdate` now resyncs the displayed collection per scope.
