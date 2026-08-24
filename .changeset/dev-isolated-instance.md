---
"@runfusion/fusion": minor
---

summary: Add `pnpm dev --isolated` to run the dev server against its own database and project directory.
category: feature
dev: Inside a machine already running Fusion, a plain `pnpm dev` shares the live database: everything durable hangs off `$HOME/.fusion` and `embedded-lifecycle` attaches to an existing postmaster when the data dir already has one. `--isolated` (also `--isolated=<dir>`, `FUSION_DEV_ISOLATED=1`) spawns the dev child with `HOME` pointed at a sandbox, giving it its own settings, credentials, central DB and Postgres cluster on its own port. It also sets the child's `cwd`, because `fn dashboard` derives its project from the working directory and has no project flag — without that, both instances share `<repo>/.fusion/tasks/`, which the orphaned-task-dir sweep re-imports, so a fresh dev database adopts the real instance's tasks. The sandbox defaults to `~/.fusion-dev/<checkout-name>/{home,project}` — outside the work tree and keyed by checkout — and the project dir is `git init`-ed on first use. Safe because `PRELOAD`/`LOADER`/`ENTRY` are already absolute paths.
