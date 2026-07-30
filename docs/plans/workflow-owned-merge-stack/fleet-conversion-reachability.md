# Fleet conversion reachability — measured, repo-wide

<!--
FNXC:WorkflowResolvedColumns 2026-07-30-14:10:
Why this document exists: the fleet work order is "claim the largest unclaimed file cluster and
convert it". Two workers independently discovered that the largest cluster cannot be batch-converted
(#2683, #2684 on self-healing.ts) and a third discovered the helper set covered only 6% of the
backlog (#2685). This measures the whole backlog ONCE so the remaining workers do not each pay the
same discovery cost on their first file.
-->

## Summary

The backlog is **722 COLUMN guards**. Two independent constraints gate conversion, and neither is
visible from the census's per-file counts — which is what the work order sorts on.

| Constraint | Guards affected | Discovered by |
|---|---:|---|
| No role helper for the role | 680 of 722 (94%) | #2685 |
| Helpers not importable from the call site's package | 572 of 722 (79%) | this note |
| Column flags not in scope at the guard | see below | #2683/#2684 (one file), this note (repo-wide) |

## 1. Where the guards actually live

The role helpers (`isIntakeColumnRole`, `isPreImplementationColumnRole`, `isHoldColumnRole`) live in
`packages/dashboard/app/utils/columnRoles.ts` — a **dashboard-app** module. Engine, core, CLI, and
the dashboard *server* cannot import it.

| Location | Guards | Share | Helpers importable? |
|---|---:|---:|---|
| `packages/engine/**` | 316 | 43% | no |
| `packages/dashboard/app/**` | 150 | 20% | **yes** |
| `packages/core/**` | 148 | 20% | no |
| `packages/dashboard/src/**` (server) | 78 | 10% | no |
| `packages/cli/**` | 24 | 3% | no |
| plugins | 6 | 1% | no |

**150 of 722 (20%)** sit where the existing helpers can be called at all. Widening the helper *set*
(#2685) does not change this number — it is about the module's location, not its coverage.

Core already exports `resolveColumnFlags`, so a core-side predicate module would be the same
abstraction made reachable rather than a new one. That is a prerequisite for the other 80%, and it
is **not** sufficient — see the next section.

## 2. The binding constraint: flags are not in scope at most guards

A role predicate needs the column's resolved trait flags. Many guards run in functions that receive
a bare task row and have no workflow IR to resolve flags from. Threading one in changes a function
signature and its call graph — a **behavior change, out of scope** for fleet conversion.

File-level proxy over the 572 non-dashboard guards (does the *file* reference
`resolveColumnFlags` / `findColumn` / `WorkflowIr` / `columnFlags` at all?):

- **339** in files that do reference one — *possibly* convertible
- **233** in files with no IR/flags reference anywhere — not convertible without threading

**That proxy overstates convertibility, and the overstatement is the point.** Reachability varies
*within* a single file, so a file-level verdict is not usable. Measured in `scheduler.ts`:

| Site | Context | Convertible? |
|---|---|---|
| `:1690` | `resolveWorkflowIrById(...)` + `resolveColumnFlags(c)` resolved in the same block | **yes** |
| `:231` | `isLegacyDependencySatisfied(dep: Task \| undefined)` — task only | no, without a signature change |
| `:341` | `shouldHoldActiveFileScopeLease(...)` — task only | no, without a signature change |

`scheduler.ts` is the largest *unclaimed* cluster (28) and is already mixed. So per-site triage is
required for every cluster; "convert the file" is not a unit of work that exists here.

### Worked example of a guard that must be skipped, not converted

`packages/core/src/task-merge.ts:254` — `getTaskMergeBlocker`:

```ts
if (!options.skipColumnIdentityCheck && task.column !== "in-review") {
```

The parameter is `Pick<Task, "column" | "paused" | "status" | "error" | "steps" | "workflowStepResults">`
— no IR, by design. The in-source FNXC comment records that callers who *have* resolved the
`merge-blocker` trait pass `skipColumnIdentityCheck` rather than spoofing
`{ ...task, column: "in-review" }`. The trait-aware path already exists **beside** this literal;
the literal is the fallback for callers that have not proven lane identity.

Converting it would not remove a legacy id — it would delete the fallback that the option was
introduced to make explicit. **Flag and skip.**

## 3. What this implies for the work order

- Sorting by per-file guard count sorts by a number that does not predict convertibility.
- A cluster's real unit of work is *(site, is-flags-in-scope)*, which the census does not emit.
- The two prerequisites are ordered: role-helper coverage (#2685) → a core-reachable module → then
  conversion. Claiming clusters before the first two land produces per-file rediscovery, which is
  what #2683, #2684, #2685, and this note each are.

**Useful census upgrade** (not done here — it changes the census, which is the shared instrument and
not mine to change unannounced): emit per-site whether trait flags are resolvable in the enclosing
scope. That turns the work order from "largest file" into "largest *convertible* cluster" and makes
the baseline shrink predictable, which the fleet rules require ("the baseline must shrink by exactly
your converted count").

## Method

- Counts from `node scripts/lifecycle-column-census.mjs --json` (`byFile`), the authoritative
  instrument — never grep.
- Package attribution by path prefix on `byFile`.
- Flag-reachability proxy by `grep` for the four resolver identifiers, **file-level**, stated as a
  proxy because it is one.
- Per-site verdicts in §2 read from source at the cited lines.
- Claim collisions checked against each open PR's **merge base**, not against `origin/main`: diffing
  a branch against main reports a difference when the branch is merely stale (the file did not exist
  at its base), which falsely flags unrelated PRs as touching a file.
  `feature/code-organization-wave17` is excluded from collision checks — 1556 files, 150 commits
  behind main, already `DIRTY`; it must rebase wholesale regardless, and treating it as a claim
  would mark every cluster in the backlog as taken.
