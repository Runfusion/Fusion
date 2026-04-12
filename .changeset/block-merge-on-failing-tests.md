---
"@gsxdsm/fusion": minor
---

Block merges when review-cycle tests fail

When `settings.testCommand` is not explicitly configured, Fusion now automatically infers a default test command from the project's package manager lock file:

- `pnpm-lock.yaml` → `pnpm test`
- `yarn.lock` → `yarn test`
- `bun.lock` / `bun.lockb` → `bun test`
- `package-lock.json` → `npm test`

This ensures that merges are blocked when tests fail, even without manual configuration of `testCommand`. Explicit `settings.testCommand` always takes precedence over inferred defaults.

Verification failures remain hard blockers — non-zero exit codes prevent task completion and keep tasks out of `done`.
