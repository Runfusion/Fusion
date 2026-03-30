---
"@dustinbyrne/kb": minor
---

Add batch GitHub issue import with intelligent throttling

- New `POST /api/github/issues/batch-import` endpoint for importing multiple issues sequentially
- Throttled request utility with exponential backoff and Retry-After header support
- Rate limit protection: 1 batch request per 10 seconds per IP
- Frontend API client function `apiBatchImportGitHubIssues()` with full type support
- Comprehensive test coverage for retry logic, validation, and error handling
