---
"@runfusion/fusion": patch
---

summary: Stop sending "needs operator action" alerts for tasks that are running normally.
category: fix
dev: Wedge classification now requires real pause state for pause-reason-derived reasons, and NotificationService revalidates the descriptor against the live task before claiming an episode.
