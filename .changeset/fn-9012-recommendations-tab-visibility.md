---
"@runfusion/fusion": patch
---

summary: Show the task Recommendations tab only when a completed task has recommendations.
category: fix
dev: TaskDetailModal gates hasRecommendations on task-owned recommendations (fullDetail?.id === task.id, else the live prop); tab reconciliation waits for that same proof, not detailLoading.
