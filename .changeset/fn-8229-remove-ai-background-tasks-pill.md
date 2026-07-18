---
"@runfusion/fusion": minor
---

summary: Remove the footer AI session pill; background progress now appears in the session notification banner.
category: feature
dev: Deletes BackgroundTasksIndicator and its footer wiring. The banner now shows non-planning generating and retained error sessions; planning remains in its docked view and nav badge, while cli-agent progress is observational to avoid a dead Resume action.
