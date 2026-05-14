---
"@runfusion/fusion": patch
---

Add per-task retry observability and guardrails across core, engine, and dashboard surfaces. Tasks now expose a derived `retrySummary` breakdown (including new branch-conflict recovery, reviewer context retry, and reviewer fallback retry counters), the engine emits structured `retry-burned` logs, and retry caps can hard-fail with `RetryStormError` when `maxTotalRetriesBeforeFail` is exceeded. The dashboard now surfaces retry totals on cards, list view, and task detail breakdowns, and existing databases auto-migrate schema version `72 -> 73` on startup.
