---
"@gsxdsm/fusion": patch
---

Fix real-time dashboard updates for project-scoped views. Previously, project-scoped API routes and SSE subscriptions created separate TaskStore instances via `getOrCreateForProject()`, causing SSE listeners to attach to a different in-memory EventEmitter than the one handling mutations. A shared project-store resolver now caches and reuses TaskStore instances per project, ensuring live events reach SSE subscribers without manual refresh.
