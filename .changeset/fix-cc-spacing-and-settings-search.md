---
"@runfusion/fusion": patch
---

summary: Fix collapsed Command Center spacing and mailbox badge padding; make recommendation settings searchable.
category: fix
dev: AgentActivityPanel.css used an undefined numeric `--space-1/2/3` scale (FN-8866) and MailboxStructuralItem.css referenced undefined `--space-2xs` (FN-8872), zeroing gaps/padding — mapped to the defined named token scale. Settings search index gains `maxRecommendationsPerTask` (FN-8829) and `recommendationMailboxNoticeEnabled` (FN-9021); MergeSection's `requiredChecks` row now uses the `SettingsTextRow` primitive so the FN-8855 search entry actually scroll-anchors.
