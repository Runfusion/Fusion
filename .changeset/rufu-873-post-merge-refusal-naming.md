---
"@runfusion/fusion": patch
---

summary: Post-merge finalize now names the real reason it withheld a card, and every card keeps its own refusal line.
category: fix
dev: `resumeMissingPostMergeGate` split one `engine-paused` arm into `engine-paused` / `auto-merge-off` / `manual-pr-open`; the History-line churn bound in `auto-merge-finalization.ts` is keyed per card, so one card's identical refusal signature can no longer silence another card's History entry.
