---
title: "Resolving review feedback across workflow-owned merge stack PRs"
date: 2026-06-10
category: architecture-patterns
module: workflow-owned merge
problem_type: architecture_pattern
component: development_workflow
severity: high
applies_when:
  - "Migrating merge ownership across stacked PR branches"
  - "Review feedback changes an invariant inherited by descendant slices"
  - "Workflow projection, retry scheduling, merge classification, or recovery events span multiple PRs"
  - "Commit shape and review-thread state are part of merge readiness"
tags: [workflow-owned-merge, stacked-prs, review-feedback, retry-scheduling, recovery-events, deletion-guards]
related_components:
  - testing_framework
  - documentation
  - tooling
---

# Resolving review feedback across workflow-owned merge stack PRs

## Context

The workflow-owned merge migration was shipped as stacked PRs: each slice branch
depended on the previous one, and each PR represented a narrow migration stage.
Review feedback arrived across the stack after implementation had already been
added, which made the normal "fix the current branch" reflex unsafe.

Several comments were stack-level invariant checks rather than isolated nits:
merge-request projection could leave stale manual-hold work, merge classifier
fallbacks could route transient results as failures, retry backoff could overflow
dates, recovery events could invent errors, zero retry attempts could disappear,
and deletion guards could pass while reading the wrong file. Fixing those only
on the top branch would make later PRs look correct while earlier PRs still
exported the broken contract to every descendant.

Session history reinforced the same pattern: a prior branch-fix session found
that the active workspace had updated call sites while another descendant
worktree still carried a stale signature, showing why stacked review feedback
must be fixed at the earliest affected branch and rebased forward. It also
showed that validation must use repo-documented commands rather than assumed
package scripts. (session history)

## Guidance

Treat stacked PR review feedback as a stack invariant audit.

1. Inventory every unresolved thread across the stack before editing.
2. Classify each comment by the earliest slice whose contract is wrong.
3. Fix that earliest branch, including a focused regression test.
4. Rebase every descendant branch in order.
5. Preserve each slice as a reviewable unit, typically one compliant commit with
   the required task prefix and trailer.
6. Verify the top branch with targeted tests and typechecks that include every
   changed invariant.
7. Push with `--force-with-lease`, then reply to and resolve each review thread
   with the concrete fix.

The implementation fixes should live where the invariant first appears, not
where the reviewer happened to comment last.

### Projection cleanup

When one durable state is projected into workflow work, clean up stale
opposite-kind work for the same task. In the merge-request projection path, a
manual hold and a succeeded merge are mutually exclusive active interpretations:

```ts
const kind = record.state === "manual-required" ? "manual-hold" : "merge";
const item = this.upsertWorkflowWorkItem({
  runId,
  taskId,
  nodeId,
  kind,
  state,
  attempt,
  lastError,
  blockedReason,
});

this.cancelActiveWorkflowWorkItemsForTask(taskId, {
  kinds: [kind === "manual-hold" ? "merge" : "manual-hold"],
  now: opts.now ?? record.updatedAt,
  lastError: "superseded-by-merge-request-projection",
});
```

The regression should use one task that transitions from `manual-required` to
`succeeded`; table-driven tests that create a fresh task per state do not catch
stale projection rows.

### Routing signal classification

Merge primitive results can carry routing signals in `value` even when `data` is
absent. If the signal is transient or manual-routing metadata, route it through
the workflow graph as a successful primitive with a retry/manual value:

```ts
if (value === "transient-failure" || value === "manual-required" || value === "stale-head" || value === "not-actionable") {
  return { outcome: "success", value };
}
return { outcome: primitiveOutcome, value };
```

### Retry and projection values

Use nullish checks for state values where zero is meaningful:

```ts
attempt: task.mergeRetries ?? task.mergeTransientRetryCount ?? undefined,
```

Cap exponential retry delay before building timestamps:

```ts
const baseDelayMs = Math.max(1_000, Math.floor(input.baseDelayMs ?? 30_000));
const maxDelayMs = 24 * 60 * 60_000;
const delayMs = Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), maxDelayMs);
```

### Recovery events

Do not manufacture an error string for informational recovery work:

```ts
lastError: input.reason ?? null,
```

When self-healing still performs legacy cleanup during a migration, also emit
workflow recovery work so the workflow-owned path can observe and route the
fact:

```ts
publishWorkflowRecoveryEvent(this.store, {
  taskId: task.id,
  kind: "transient-merge-failure",
  source: "self-healing",
  reason: errorSnippet,
});
```

### Guard tests

Deletion guards must read the boundary they claim to protect. When the legacy
owner still exists during a staged migration, a useful guard can assert both
sides of the boundary:

- the legacy owner still contains the old mechanism until the deletion slice
  removes it;
- the workflow-owned processor or recovery publisher remains isolated from that
  mechanism.

This turns the guard into a migration boundary assertion instead of a false
green.

## Why This Matters

Stacked migrations fail in ways single PRs do not. A late-branch fix can hide
the fact that an earlier PR still exports the broken behavior; after review,
squash, or rebase, the stack can regress even though the top branch looked
right.

Workflow-owned merge state has especially tight invariants:

- `0` is a valid retry value, not absence;
- manual-hold and succeeded merge projections must not both stay active;
- transient/manual routing values should select workflow edges, not permanent
  primitive failure;
- retry backoff must remain operationally bounded;
- recovery facts must not invent errors;
- guard tests must prove the actual boundary being migrated.

Resolving feedback at the earliest affected branch makes those invariants part
of the stack's ancestry. Rebasing descendants then verifies that every later
slice inherits the corrected contract.

## When to Apply

- Stacked PRs where each branch depends on the previous branch.
- Workflow, merge, retry, recovery, or self-healing migrations.
- Review feedback that identifies an invariant shared by multiple slices.
- Projection code that maps one domain state model into another.
- Migration guard tests that could pass by reading a file where the legacy
  behavior never existed.
- Branches whose commit shape is part of the merge gate or audit contract.

## Examples

### Stack repair loop

```bash
# Fix the earliest affected branch.
git checkout feature/workflow-owned-merge-s02-merge-request-projection
# edit, run focused tests, amend the slice commit

# Rebase each descendant in order.
git checkout feature/workflow-owned-merge-s03-generic-scheduler-claim
git rebase --onto feature/workflow-owned-merge-s02-merge-request-projection <old-s02-sha>

# Publish rewritten branches safely.
git push --force-with-lease origin feature/workflow-owned-merge-s02-merge-request-projection ...
```

Use `--onto` when the parent branch was rewritten; a normal rebase can try to
replay old parent commits and create add/add conflicts in slice docs.

### Verification set

The corrected workflow-owned merge stack was verified with focused tests and
typechecks:

```bash
pnpm --filter @fusion/core exec vitest run \
  src/__tests__/merge-request-record.test.ts \
  src/__tests__/workflow-work-projection.test.ts \
  --silent=passed-only --reporter=dot

pnpm --filter @fusion/engine exec vitest run \
  src/__tests__/workflow-merge-nodes.test.ts \
  src/__tests__/workflow-node-retry-policy.test.ts \
  src/__tests__/workflow-recovery-events.test.ts \
  src/__tests__/workflow-scheduler-policy-deletion.test.ts \
  src/__tests__/workflow-merge-policy-deletion.test.ts \
  src/__tests__/workflow-self-healing-policy-deletion.test.ts \
  src/__tests__/workflow-cutover-matrix.test.ts \
  --silent=passed-only --reporter=dot

pnpm --filter @fusion/core typecheck
pnpm --filter @fusion/engine typecheck
```

Do not substitute assumed scripts for the documented verification commands.
A prior session attempted a package-level TypeScript script that did not exist;
that added noise without validating the stack. (session history)

## Related

- `docs/solutions/architecture-patterns/workflow-native-runtime-primitives.md`
  covers the broader workflow policy / runtime primitive / engine substrate
  split that this stack is migrating toward.
- `docs/solutions/best-practices/merge-conflict-extraction-vs-semantics-and-parallel-bootstrap.md`
  covers adjacent merge hygiene when branch structure and semantics diverge.
- `docs/solutions/architecture-patterns/thin-trusted-merge-gate.md` covers the
  project rule that merge gates stay thin and trusted.
- GitHub issues related to this area include Runfusion/Fusion#1453,
  Runfusion/Fusion#1356, and Runfusion/Fusion#1376.
