---
"@runfusion/fusion": minor
---

summary: Show a local codebase token estimate and on-disk size on the project Dashboard Overview.
category: feature
dev: New GET /api/projects/:id/codebase-metrics; calibrated cl100k_base pre-tokenization estimator with separate bounded source/disk domains, symlink-safe local traversal, two-minute caching, and granular shared B/KB/MB/GB formatting.
