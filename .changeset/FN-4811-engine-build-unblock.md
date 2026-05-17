---
"@runfusion/fusion": patch
---

fix(FN-4811): unblock `@fusion/engine` typecheck so verification bootstrap can run

Restores `pnpm --filter @fusion/engine build` after a stack of TypeScript regressions blocked every merge. Symptoms: every task hitting pre-merge verification failed with "Verification bootstrap preamble failed — workspace dist artifact rebuild did not complete" because the bootstrap shells `pnpm --filter @fusion/engine build` and that compile was erroring on 17 type issues.

Fixes:
- Remove duplicate `RemovalReason` re-export in `worktree-pool.ts` (`export type` + `export` for the same identifier produced TS2300 "Duplicate identifier").
- Add `worktree:removal-refused-active-session` and `worktree:removal-forced-over-active-session` to the `GitMutationType` union in `run-audit.ts` so the new FN-4811 audit events are accepted.
- Update `self-healing.test.ts` `vi.mock("../worktree-pool.js")` to mirror the production `RemovalReason` const exactly (was missing keys, causing `reason: undefined` to flow into mock calls and confusing error messages).
- Add `reason: RemovalReason.MergerCleanup` to existing `worktree-backend.test.ts` `removeWorktree` calls now that `reason` is a required parameter.
