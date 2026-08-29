---
title: eslint-disable for react-hooks/exhaustive-deps fails CI lint (rule not registered)
date: 2026-06-21
category: docs/solutions/build-errors
module: dashboard
problem_type: build_error
component: tooling
symptoms:
  - "CI Lint job fails: Definition for rule 'react-hooks/exhaustive-deps' was not found  react-hooks/exhaustive-deps"
  - "Local `pnpm test` (vitest) passes green while the PR's Lint check goes red"
root_cause: config_error
resolution_type: code_fix
severity: medium
tags: [eslint, react-hooks, exhaustive-deps, ci-lint, lint, flat-config]
---

# eslint-disable for react-hooks/exhaustive-deps fails CI lint (rule not registered)

## Problem
This repo's flat `eslint.config.mjs` does not register the `react-hooks/exhaustive-deps` rule. A `// eslint-disable-next-line react-hooks/exhaustive-deps` directive — the usual way to silence a deliberately-incomplete `useEffect` dependency array — therefore references a rule ESLint doesn't know, and `eslint .` treats the unknown rule name in a disable directive as a hard error. The PR's CI `Lint` job fails.

## Symptoms
- CI `Lint` job (`pnpm lint` → `eslint .`) fails with: `Definition for rule 'react-hooks/exhaustive-deps' was not found  react-hooks/exhaustive-deps`.
- The failure does **not** reproduce under `pnpm test` / vitest — those never invoke ESLint, so the whole feature's test suite is green locally while the Lint check is red on the PR.
- Often the only file flagged is the one that added the directive (e.g. a single `useEffect` with an intentionally trimmed dep array).

## What Didn't Work
- Assuming a green local `pnpm test` meant the branch was CI-clean. Vitest runs through `tsx` and does not lint, so an eslint-only failure is invisible until CI (or an explicit `pnpm lint`) runs.
- Treating it as a missing-dependency warning to satisfy. The error is not exhaustive-deps complaining about the dep array — it's ESLint rejecting the *disable directive* because the named rule isn't registered. Adding the "missing" dep would not silence it; only the directive itself is the problem.

## Solution
Remove the `eslint-disable` directive. Because `react-hooks/exhaustive-deps` is not enforced in this config, the intentionally-incomplete dep array needs no suppression at all. Keep a plain explanatory comment for the human reader.

```tsx
// Before — fails CI lint:
    // onEnabledWorkflowStepsChange intentionally omitted: a new identity each render
    // must not re-trigger the fetch/re-seed (would clobber user toggles).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onWorkflowIdChange, effectiveOptionalWorkflowId, projectId]);

// After — passes:
    // onEnabledWorkflowStepsChange intentionally omitted from deps: a new identity
    // each render must not re-trigger the fetch/re-seed (would clobber user toggles).
    // Callers must pass a stable callback (NewTaskModal passes a useState setter).
  }, [onWorkflowIdChange, effectiveOptionalWorkflowId, projectId]);
```

## Why This Works
ESLint validates rule names referenced in inline disable directives against the rules actually registered by the active config. The flat `eslint.config.mjs` here does not load the `react-hooks` plugin's `exhaustive-deps` rule, so the name is unknown and the directive errors out. Removing the directive removes the dangling reference. There is no behavioral regression: with the rule unregistered, the incomplete dep array was never going to be flagged in the first place — the suppression was protecting against a check that doesn't run.

## Prevention
- **Don't add `eslint-disable` for `react-hooks/exhaustive-deps` in this repo.** When deliberately omitting a dependency, document the intent in a plain comment and rely on the dep array as written. (If exhaustive-deps enforcement is ever wanted repo-wide, register the rule in `eslint.config.mjs` first — then the directive becomes valid.)
- **Run `pnpm lint` (or `npx eslint <changed-files>`) before pushing.** A passing `pnpm test` does not cover lint — vitest and ESLint are independent gates, and the CI `Lint` job (`.github/workflows/pr-checks.yml`) is the first place an eslint-only error surfaces otherwise.
- Before suppressing any rule with an inline directive, confirm the rule is actually registered in the active flat config; an unknown rule name in a disable directive is itself a lint error under `eslint .`.

## Related Issues
- Surfaced and fixed during the workflow-optional-steps work (PR #1703), commit `e16d48910` "fix(ci): drop unknown react-hooks/exhaustive-deps disable directive in TaskForm".
- Related to the broader "lint/typecheck gates are separate from vitest" gotcha: TS editor diagnostics and vitest both miss eslint-only failures in `packages/dashboard`.
- `docs/solutions/architecture-patterns/thin-trusted-merge-gate.md` — establishes `Lint` as one of the four merge-blocking CI checks (Lint, Typecheck, Build, Gate). That CI topology is why this failure surfaces only on the PR: `pnpm test`/vitest is not one of those gates and never invokes ESLint.
