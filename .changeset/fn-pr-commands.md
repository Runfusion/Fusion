---
"@runfusion/fusion": major
---

Add the unified `fn pr` command namespace for CLI parity with the dashboard's
PR-entity review surface (U8, R13): `fn pr create | list | show | approve |
respond | retry | merge | close | automerge`.

Each subcommand routes to the SAME store/engine/release path the dashboard PR
routes use, so the two surfaces can't diverge: `create` mints the GitHub PR;
`list`/`show` read PR entities; `approve`/`respond`/`retry`/`merge`/`close` fire
the workflow's user-controlled release edges via `releaseHeldTaskByEvent`
(`pr-approve`/`pr-respond`/`pr-retry`/`pr-merge`/`pr-close`); `automerge` toggles
the entity's `autoMerge` flag.

BREAKING: the per-task `fn task pr-create` command is retired. Use `fn pr create
<task-id>` instead (same flags: `--title`, `--base`, `--body`, `--draft`,
`--no-ai`, `--reviewer`).
