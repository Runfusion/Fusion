---
"@dustinbyrne/kb": minor
---

Add `kb task pr-create` command for creating GitHub PRs from in-review tasks

The new CLI command enables headless GitHub workflows for users who prefer the CLI over the dashboard web UI:

- `kb task pr-create <id>` - Create a PR for a task in the "in-review" column
- `kb task pr-create <id> --title "Custom PR title"` - Override the default PR title
- `kb task pr-create <id> --base develop` - Target a different base branch
- `kb task pr-create <id> --body "PR description"` - Add a PR description

The command validates that the task is in the "in-review" column, determines the repository from `GITHUB_REPOSITORY` env var or git remote, and requires GitHub authentication via `gh auth login` or `GITHUB_TOKEN`.
