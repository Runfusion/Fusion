---
title: Shared-infra catch-all forces gate mode, silently dropping changed-package coverage
date: 2026-06-19
category: logic-errors
module: scripts/test-changed
problem_type: logic_error
component: testing_framework
symptoms:
  - "`pnpm test` ran ~700 fixed engine-core + cli-shape tests while the developer's actually-changed packages got zero coverage"
  - "`node scripts/test-changed.mjs --print-mode` reported `mode=gate reason=shared-infra-changed` on a branch that only touched package source plus a data file"
  - "Changed packages (@fusion/core, @fusion/dashboard) resolved as affected but never ran"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components:
  - development_workflow
tags:
  - test-changed
  - gate-mode
  - test-selection
  - affected-packages
  - shared-infra
  - quarantine
  - silent-coverage-loss
---

# Shared-infra catch-all forces gate mode, silently dropping changed-package coverage

## Problem

`pnpm test` (→ `scripts/test-changed.mjs`) routed to **gate mode** whenever the diff touched `scripts/lib/test-quarantine.json` — a runtime data list of quarantined tests, not executable infra. Gate mode runs only the fixed merge-gate slice (`pnpm test:gate` = engine-core + cli ci-shape) and **returns before the affected packages**, so a developer who also edited the quarantine list got zero coverage of their real changes.

## Symptoms

- `pnpm test` spent ~22s passing ~700 engine/cli tests unrelated to the change; the changed code never ran.
- `--print-mode` showed `mode=gate reason=shared-infra-changed packages=0` on a branch whose only "infra" file was `scripts/lib/test-quarantine.json`.
- The affected-package resolver, given the same diff minus the quarantine file, correctly returned `[@fusion/core, @fusion/dashboard]` — proving the coverage was being dropped, not just unselected.

## What Didn't Work

- **Assuming the gate suite covers the change** — gate mode runs a *fixed* slice (engine-core + cli ci-workflow shape) regardless of what changed. It is a trust signal, not a coverage signal for arbitrary packages. Reading only the green output hides the gap.
- **Blaming the cache** — the content-hash cache was a red herring; the run never reached the affected-package path at all because `decideExecutionPlan` short-circuited to `gate` first.

## Solution

The catch-all in `isSharedInfraChange` (`scripts/test-changed.mjs`) treats *any* changed file outside `packages/`, `plugins/`, or `docs/` as shared infra. The quarantine data file hit it. Classify it as test-irrelevant in `isTestIrrelevantRootPath` so the diff stays in changed mode:

```js
// scripts/test-changed.mjs — isTestIrrelevantRootPath
// The quarantine list is runtime DATA (which tests are skipped), not
// executable test infra. Editing it must not trip the root catch-all below
// and force gate mode — gate mode drops affected-package coverage.
if (file === "scripts/lib/test-quarantine.json") {
  return true;
}
```

After the fix, `--print-mode` reports `mode=changed` and the affected packages run again. Regression tests in `scripts/__tests__/test-changed.test.mjs` assert the quarantine list — alone and alongside package changes — stays in changed mode. Shipped in PR Runfusion/Fusion#1686.

## Why This Works

`decideExecutionPlan` checks `isSharedInfraChange(changedFiles)` **before** resolving affected packages, and gate mode is terminal (`runMaybeIsolated("test:gate")` then `return`). So the shared-infra signal doesn't *augment* affected coverage — it **replaces** it. That tradeoff is defensible for a genuine infra change (you can't trust the affected-resolution when the resolver's own inputs moved), but a quarantine-list edit doesn't invalidate affected resolution; it's just data. Marking it test-irrelevant lets the diff fall through to normal affected-package selection (which still runs the gate first, then the affected set), so the developer's real changes get tested.

## Prevention

- **Know the replacement semantics**: in `test-changed`, shared-infra/gate mode *replaces* affected-package coverage rather than adding to it. Any changed file not under `packages/`, `plugins/`, or `docs/` hits the catch-all and silently drops changed-code testing until it's explicitly allowlisted in `isTestIrrelevantRootPath`.
- **Allowlist new data/config files under `scripts/`**: when adding a runtime data file (JSON lists, fixtures, generated catalogs) that lives outside the package tree, add it to `isTestIrrelevantRootPath` — or it will force every diff that touches it into gate-only mode.
- **Verify mode, not just green**: when a test run looks suspiciously fast or generic, run `node scripts/test-changed.mjs --print-mode`. `mode=gate reason=shared-infra-changed packages=0` on a branch with real package changes is the tell that coverage is being dropped.
- **Test the coverage invariant, not just the boolean**: the regression test asserts a quarantine edit + package change stays in changed mode — i.e. that the *affected packages would run*, not merely that `isSharedInfraChange` returns false.

## Related Issues

- PR Runfusion/Fusion#1686 — the fix this doc documents
- [files-changed-inflated-by-origin-first-base-commit](./files-changed-inflated-by-origin-first-base-commit.md) — adjacent test/diff-tooling logic bug in the same `scripts`/engine tooling family
