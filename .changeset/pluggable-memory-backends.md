---
"@gsxdsm/fusion": minor
---

feat: Pluggable memory backend system with file and readonly backends

- Added `FileMemoryBackend` with atomic writes, persistence, and conflict resolution
- Added `ReadOnlyMemoryBackend` for read-only/external memory management
- Added `memoryBackendType` setting to select backend type (`file` or `readonly`)
- Added `GET /api/memory/backend` endpoint to query current backend status and capabilities
- Updated documentation with architecture, settings, and operational guidance

Related to FN-1420.
