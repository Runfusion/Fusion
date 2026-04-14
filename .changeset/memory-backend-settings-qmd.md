---
"@gsxdsm/fusion": minor
---

Add dashboard memory settings UX for qmd backend with capability-aware editing

- Add `fetchMemoryBackendStatus` API wrapper in dashboard for `GET /api/memory/backend`
- Add `useMemoryBackendStatus` hook for frontend backend status management
- Update Settings > Memory section with:
  - Backend type selector populated from API `availableBackends`
  - Capability-aware editing (read-only when backend is non-writable)
  - User feedback explaining why editing/saving is disabled
- Update documentation for qmd backend semantics and fallback behavior
