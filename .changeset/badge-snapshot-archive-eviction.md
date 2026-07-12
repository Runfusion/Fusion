---
"@runfusion/fusion": patch
---

summary: Fix a slow dashboard memory leak where archived tasks were never evicted from the in-memory badge cache.
category: performance
dev: The badge-snapshot cache (packages/dashboard/src/server.ts) only removed a task on hard-delete, so archiving a task re-cached it via the task:updated listener and it was retained for the daemon's lifetime — unbounded growth over long uptimes with task churn. A new `isBadgeEligibleTask` predicate (column !== "archived") gates both the create and update listeners so archived tasks are evicted, matching the startup prime's `includeArchived:false`. An unarchive re-primes the entry.
