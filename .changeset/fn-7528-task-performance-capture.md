---
"@runfusion/fusion": minor
---

summary: Capture a structured performance snapshot when an agent task completes.
category: feature
dev: New AgentReflectionService.captureTaskPerformance persists a non-LLM post-task ReflectionMetrics record (duration, packages/files touched, verification command + scope, retry/rework count) and emits ids/counts-only `reflection:captured` run-audit telemetry; populates performanceSummary/latestReflection.
