---
"@runfusion/fusion": patch
---

summary: Scrub top-level report activityTrace before filing so paths and tokens never reach the pipeline.
category: security
dev: /api/report/file now runs scrubReportPayload on raw.activityTrace before parseInput/runReportPipeline; route regression in report-routes.test.ts.
