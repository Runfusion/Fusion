# fusion-plugin-quality

First-party Fusion plugin that makes task QA easy and visual.

## Surfaces

- **Quality hub** (left sidebar): project-wide test run history and plans
- **Task QA tab**: action-first task quality work
  - Task-scoped preview / test server (worktree cwd)
  - Allowlisted targeted tests + report viewer
  - Screenshots / visual evidence (task artifacts)
  - Suggested test cases (advisory checklist)
  - PR checks, browser verification handoff

## Design principles

- Orchestrates existing verification (`testCommand`, gate, verify-fast) — does **not** replace the merge gate
- Composes Dev Server process patterns and the artifact registry
- Composes `fusion-plugin-agent-browser` for browser verification (soft dependency)
- Never uses port 4040; never free-form shell as the default path
- Advisory results only — does not change merge eligibility

## Settings

See plugin `settingsSchema` in `src/settings.ts`.
