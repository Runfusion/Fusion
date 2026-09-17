---
"@runfusion/fusion": patch
---

summary: Show AI merge review reconciliation in a task's Details tab instead of its Definition tab.
category: fix
dev: Moves the `ai-merge-review-reconciliation` section in `TaskDetailModal.tsx` from the `activeTab === "definition"` branch to the head of the `activeTab === "details"` branch; markup, i18n keys, and `handleDismissAiMergeFinding` are unchanged.
