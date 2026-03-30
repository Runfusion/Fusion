---
"@dustinbyrne/kb": minor
---

Add ability to import new tasks from GitHub issues

Users can now run `kb task import <owner/repo>` to fetch open issues from a GitHub repository and create tasks from them. Each imported issue becomes a task in the "triage" column with:
- Issue title as task title (truncated to 200 chars)
- Issue body as description with source URL appended
- Duplicate detection based on source URL

Options:
- `--limit, -l <n>`: Max issues to import (default: 30, max: 100)
- `--labels, -L <labels>`: Comma-separated label filter (e.g., "bug,enhancement")

Pi extension also includes new `kb_task_import_github` tool for programmatic access.

Requires `GITHUB_TOKEN` env var for private repositories and to avoid rate limits.
