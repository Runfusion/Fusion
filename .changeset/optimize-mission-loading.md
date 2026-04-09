---
"@gsxdsm/fusion": patch
---

Optimize mission loading performance by eliminating N+1 query patterns and adding batched API endpoints. The GET /api/missions list endpoint now uses batched queries instead of firing getMissionSummary() per mission. Added new GET /api/missions/health batch endpoint for fetching all mission health metrics in a single request. The frontend now makes 1 request instead of N parallel requests when loading mission health data. Added database indexes on mission hierarchy FK columns (milestones.missionId, slices.milestoneId, mission_features.sliceId, mission_features.taskId) to improve query performance.
