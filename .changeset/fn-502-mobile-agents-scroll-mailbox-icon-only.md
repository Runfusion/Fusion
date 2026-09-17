---
"@runfusion/fusion": patch
---

summary: Fix the unscrollable phone Agents list and show Mailbox header actions as icons only on phones.
category: fix
dev: `.agents-split-sidebar` no longer sets `flex-direction: column` on the outer `.view-sidebar` box (it removed the panel's vertical stretch and unbounded `.agents-view-content`); the panel gains `agents-split-sidebar__panel` and the phone fill chain is restated in physical `min-height`. `agents` joins `MOBILE_DRAWER_CONTENT_SCROLL_VIEWS` so the drawer body stops competing for the gesture. Mailbox's filter and mark-all-read actions now use the shared `ViewActionButton` canon in both hosts, with the pending-approvals badge carried by its new `badge` slot; the obsolete `.mailbox-view--mobile .view-header__actions .btn` padding/ellipsis rules are re-scoped to the exempt `.mailbox-agent-subtab` controls.
