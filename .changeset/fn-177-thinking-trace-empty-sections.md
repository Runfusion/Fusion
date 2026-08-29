---
"@runfusion/fusion": patch
---

summary: Make chat thinking traces readable and add a raw transcript view.
category: fix
dev: Fold body-less parseThinkingSections headings inline; parseThinkingTrace exposes inlinedHeadingCount for the raw-toggle gate, removes the empty-message span, and adds thinking.showRaw and thinking.showSections.
