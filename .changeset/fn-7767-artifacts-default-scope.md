---
"@runfusion/fusion": patch
---

summary: Fix the Artifacts tab count for default-scope dashboards.
category: fix
dev: useArtifacts now fetches and subscribes when no projectId is available, matching the default /api/artifacts scope.
