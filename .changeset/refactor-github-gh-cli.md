---
"@dustinbyrne/kb": patch
---

Refactor GitHub integration to use gh CLI

- All GitHub operations now prefer `gh` CLI authentication over `GITHUB_TOKEN`
- Added `listIssues()` and `getIssue()` methods to `GitHubClient`
- Removed in-app `GitHubRateLimiter` (gh CLI handles rate limiting)
- REST API remains available as fallback when `GITHUB_TOKEN` is set
- PR Monitor no longer requires `getGitHubToken` option
