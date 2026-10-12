---
title: "A PostgreSQL migration's identity is a bare number, so a renumbered migration silently never runs again"
date: 2026-10-12
problem_type: database_issue
module: "@fusion/core"
component: postgres/schema-applier
tags:
  - postgres
  - migrations
  - schema-version
  - fork-maintenance
  - silent-skip
symptoms:
  - "a column or index a shipped migration creates is missing on production but present on every fresh database"
  - "fusion_schema_migrations records a slot whose file on disk does different work"
  - "an upstream merge appears clean in CI and only the read path notices afterwards"
root_cause: "fusion_schema_migrations.version is a bare number and applied.includes(version) is the only skip test, so a number may name exactly one migration per database; renumbering either side of a collision re-points that test at the wrong migration"
resolution_type: code_fix
---

## Problem

Upstream (`Runfusion/Fusion`) and this line share one migration number space. When upstream released a
migration into a slot this line already held, the collision was resolved by **renumbering the incoming
upstream file** and keeping this line's own file on the slot. Each individual move looked safe; together
they made the ledger lie. `applySchemaBaseline` gates every step on:

```ts
const pullRequestReadinessAlreadyApplied = applied.includes(PULL_REQUEST_READINESS_VERSION);
if (!pullRequestReadinessAlreadyApplied || pullRequestReadinessMissing) { /* read + run the .sql */ }
```

`version` is a bare number (`'0089'`, not `0089_fn_9429_...`) and that `includes` is the only skip test.
After three such moves production recorded `0087`/`0088`/`0089` for **this fork's** migrations while the
bundled files at those numbers were **upstream's**. On every applied fork database the upstream files were
then skipped permanently — with no error, no log line, and green lint/typecheck/build/merge-gate. The only
symptom is a read path querying a column or index that was never created.

The same defect existed inside a single migration: the review-lane ledger writes its own marker inside the
same transaction as its DDL, and that literal still said `'0088'` after the file had been renamed twice —
`0088` being, after the restack, upstream FN-9512's recovery-disposition migration. A drift re-apply of the
ledger would have told a database that a column migration had run when only the ledger had.

## What Didn't Work

- **Re-issuing the incoming file at a later slot.** It preserves *our* history and corrupts the *number's*
  meaning: the vacated slot still names the old migration in every applied database, and the file that
  legitimately owns it is skipped there forever. It also has to be repeated on every upstream release (four
  times for STAS-205's ledger alone), so the drift compounds instead of stabilising.
- **Renumbering our own file instead.** Same disease, mirrored: our published marker changes meaning for our
  own databases. A published number cannot move without stranding the databases that recorded it.
- **Trusting `git merge` / GitHub `mergeable`.** Both report text conflicts only. A reused number is not a
  textual conflict; it is a bookkeeping fact about a database the merge cannot see.
- **The existing wiring guards.** `migration-wiring-integrity.test.ts` asserted the ceiling equals the
  highest file and that every `.sql` is named in the applier source. Both stayed green throughout, because
  they never compared a *marker* to its *file*.

## Solution

Adopt the rule that keeps one number meaning one migration in both lineages:

1. **Upstream's released numbers are immutable and adopted verbatim.** If upstream ships
   `0086_fn_9429_...sql`, this line bundles that file at that name and marks it `'0086'`.
2. **Our own SQL moves to the free tail.** Our migrations sort above the highest upstream slot
   (`0090` owner-FK repair, `0091` review-lane ledger, `0092` task-log projections).
3. **Leave gaps rather than fill them.** `0089` is unbundled because upstream took it for FN-9529; `0090` is
   left free on the PR branch so the next upstream release lands *below* our tail instead of onto it. A gap
   is harmless — upstream itself ships no file between `0073` and `0084`. A reused number is fatal.
4. **A slot this line occupied but has now freed gets a live-schema probe.** A fork database recorded `0087`
   for the owner-FK repair; the readiness migration now owns `0087`. The marker check alone would skip it, so
   readiness, recovery disposition, and the task-log projections probe the live column beside the marker, and
   re-apply their idempotent DDL. That converts "the marker is a lie" from a silent skip into a repair.
5. **Slots a fork does not implement stay unbundled, not bundled-unwired.** `0084` re-ships this line's own
   `0075`(+`0077`) overlap-wait schema; `0085` is upstream's feature-reduced-fork cleanup that drops five task
   columns and relocates notes/whiteboards — features this fork implements and serves, and
   `fork-extensions-doc.test.ts` already fails the build if it appears. An unwired `.sql` in `migrations/` is
   a gate failure by design, so an intentionally foreign migration is deleted, not parked.

Then make the invariant mechanical — `migration-wiring-integrity.test.ts` (no PostgreSQL, merge gate):

- a recorded marker equals the prefix of the `.sql` file it records;
- a self-marking migration writes only its own number (non-numeric rows like
  `legacy-adoption-drained` are exempt by contract);
- no number is held by two migrations, among wired pairs or among exported `*_VERSION` constants
  (the ceiling is the one documented alias);
- coverage, not a count, proves the scan still matches: every numeric file must appear in a pairing.

## Production bookkeeping surgery

Numbers already recorded in a live database cannot be renamed — that is the whole problem. What can be done
is stop a stale row from blocking a migration that has not been shipped yet. Check the shape first:

```sql
select version, applied_at from public.fusion_schema_migrations
 where version ~ '^\d{4}$' and version::int >= 84 order by version;
```

Then compare each row against the shipped file set. A row whose slot belongs to a migration this build does
**not** bundle (`0089` here, and `0084`/`0085` if upstream's excluded-feature cleanup was ever run) is a
future silent skip and must be removed **after** the build that stops bundling it is deployed — before that
deploy, the running build's own probe just re-applies and re-records it:

```sql
-- run only against a database opened by a build that no longer bundles 0089
delete from public.fusion_schema_migrations where version = '0089';
```

Verify afterwards that the recorded numeric set is a superset of the bundled files and contains no row for an
unbundled slot. Rows for migrations whose DDL is already present are kept: the point is not a pretty ledger,
it is that no shipped file is permanently skipped by a row that means something else.

## Why This Works

The skip test cannot be made smarter without a second identity, so the number itself is made stable and
unique: upstream keeps its numbers, ours live above all of them, and a freed slot is covered by a probe that
reads the schema instead of the ledger. Every rule is then enforced by a scan that runs in the merge gate, so
the next collision is a red test rather than a missing column.

## Prevention

- Never renumber a published migration in either direction. Move our **unpublished** work to a free slot; if
  it was already published, add a live-schema probe instead of trusting the marker.
- When merging upstream, read the migration directory, not just the conflict list — an unconflicting merge can
  still hand you a number you already recorded.
- A marker-only `if (!applied.includes(V))` step is only safe while `V` has never meant anything else. For a
  fork, assume it has, and probe the live schema.
- See also [`schema-version-constant-must-equal-highest-migration.md`](schema-version-constant-must-equal-highest-migration.md)
  for the SQLite ancestor of this class (a gate constant one behind the highest block).
