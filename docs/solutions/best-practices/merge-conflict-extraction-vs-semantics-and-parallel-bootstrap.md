---
title: "Resolving extraction-vs-semantic merge conflicts and parallel-bootstrap add/add collisions"
date: 2026-06-03
category: docs/solutions/best-practices
module: "packages/engine + repo-root accretive docs"
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - "A PR branch extracted code into a helper while main changed that same block's semantics"
  - "Git shows a one-line call versus a new multi-line block and neither verbatim side is correct"
  - "Two parallel branches each bootstrapped CONCEPTS.md or added near-identical AGENTS.md pointer lines (add/add)"
  - "A merged doc or comment still describes behavior that the very commit being merged removed"
resolution_type: workflow_improvement
tags:
  - merge-conflict
  - conflict-resolution
  - refactor-vs-semantics
  - extracted-helper
  - add-add-collision
  - concepts-md
  - merge-commit-message
---

# Resolving extraction-vs-semantic merge conflicts and parallel-bootstrap add/add collisions

## Context

Git's three-way merge reasons about *text*, not *intent*. A treacherous conflict class arises when the two sides operate on the same code at different layers: one branch performs a **structural refactor** (extracts/moves a block, behavior-preserving) while main performs a **semantic change** (alters what that block does). Git presents an ordinary either/or conflict, but **both "pick a side" resolutions are wrong** — one discards the refactor, the other silently reverts the semantic change, and the second failure mode is invisible because the behavioral logic has been relocated out of git's view.

Observed merging `main` into `gsxdsm/missonsdebug` (merge `60c307320`): the branch had extracted an inline validation block from `processTaskOutcome` into a shared helper `runFeatureValidation` (`packages/engine/src/mission-execution-loop.ts`); main's FN-5902 (`cc18206bc`) changed that same block's semantics (zero-assertion auto-pass → lazy `ensureFeatureAssertionLinked`). A docs-level variant landed in the same merge: two ce-compound runs had each bootstrapped `CONCEPTS.md` (add/add), and the incoming FN-5902 semantics falsified a glossary entry the branch had written.

## Guidance

**When one side refactors code and the other changes that code's behavior, keep the refactor's structure and re-apply the semantic change at the code's new location.** Git cannot do this for you.

1. **Recognize the shape.** The tell: one conflict side is a call/one-liner, the other is a large block — the block that *used to* live there. Structure moved on one side; behavior changed on the other.
2. **Keep the call site** (preserve the refactor).
3. **Port the incoming semantic change into the helper body** at its new home — do not accept either hunk verbatim.
4. **Sweep the moved code's documentation** — a doc comment or glossary entry describing the old behavior is now a lie; fix it in the same merge.
5. **Run the merged (union) test suite + typecheck**, not just one branch's tests — the merge creates a combination neither branch tested.
6. **Name the merge commit after the adopted change** (e.g. `Merge main: adopt FN-5902 lazy assertion linkage in shared runFeatureValidation`), not a bare `merge main`.

For **accretive docs** (`CONCEPTS.md`, glossaries, registries) hitting add/add: **merge as a union** — clusters are independent; keep one preamble. For near-identical pointer lines (e.g. `AGENTS.md` references), take the wording that minimizes the diff. Then sweep the merged prose for statements the incoming commits falsified.

## Why This Matters

The dangerous resolution is invisible. Keeping the branch side verbatim looks clean:

```ts
await this.runFeatureValidation(feature);   // tidy one-liner — but the helper body
                                            // still contains the OLD auto-pass
```

```ts
// stale helper body — silently reverts FN-5902
if (assertions.length === 0) {
  await this.handleValidationPass(feature.id, undefined, "No assertions linked");
  return;
}
```

The merge diff shows **no trace** of the regression — the reverted logic lives in a region git never flagged. FN-5902 is silently undone and the diff passes review as a clean refactor. The mirror mistake (keeping main's block) drops the extraction and breaks the other call site that motivated it.

The collision class is not hypothetical or rare here: **four parallel branches bootstrapped or substantially extended `CONCEPTS.md` on the same day, each as a full-file write rather than an append** — so every one of them will hit this add/add when merging, until they all land.

## When to Apply

- A merge/rebase conflict where one side is a call/delegation and the other is a multi-line block that previously lived at that spot.
- One branch moved/extracted/renamed code that the other branch changed the behavior of. A prior incident in the merger had the same shape in reverse: a refactor that merged two distinct error cases into one throw site silently changed error semantics downstream. (session history)
- An add/add conflict on an accretive file (glossary, changelog, registry) — union, don't pick.
- Any merge that pulls in a semantic change — sweep merged comments/docs for falsified prose.

Do **not** resolve these with `--ours`/`--theirs` or by accepting either hunk, and do not treat a clean-looking diff as proof of a clean merge — verify with the union test suite.

## Examples

**The conflict as git presents it** (`mission-execution-loop.ts`):

```text
<<<<<<< HEAD                      ← branch: the refactor, a one-liner
      await this.runFeatureValidation(feature);
=======                           ← main: FN-5902's new inline block
      let assertions = this.missionStore.listAssertionsForFeature(feature.id);
      if (assertions.length === 0) {
        assertions = this.missionStore.ensureFeatureAssertionLinked(feature.id);
      }
      // ... validator run bookkeeping + dispatch ...
>>>>>>> origin/main
```

**Correct resolution** — keep the call, port the semantics into the helper, fix its doc comment:

```ts
private async runFeatureValidation(feature: MissionFeature): Promise<void> {
  // Lazily guarantee a linked assertion before validation so every feature
  // is evaluated by the validator even when legacy data is missing links.
  let assertions = this.missionStore.listAssertionsForFeature(feature.id);
  if (assertions.length === 0) {
    assertions = this.missionStore.ensureFeatureAssertionLinked(feature.id);  // FN-5902, ported to its new home
  }
  // ... validator run bookkeeping + dispatch (unchanged) ...
}
```

Verified with the union suite (53 tests, both branches' tests together) + typecheck.

**Docs variant** — union the CONCEPTS.md clusters under one preamble, then fix the falsified entry:

```diff
  ### Contract Assertion
- ... A Feature with no linked assertions auto-passes; a Feature with assertions counts
- toward Slice completion only after a passing Validator Run.
+ ... Every Feature is validator-evaluated — a Feature missing an assertion has one lazily
+ linked before validation — and counts toward Slice completion only after a passing Validator Run.
```

## Related

- `AGENTS.md` → "Merging Branches Into Main" — covers the *automated* squash-merge pipeline; this learning covers manual/agent conflict-resolution judgment, which that section doesn't address.
- `docs/solutions/logic-errors/mission-autopilot-stalled-by-stranded-done-feature.md` — the PR whose extraction created the conflict shape documented here.
- Merge commit `60c307320` / upstream `cc18206bc` (FN-5902) — the concrete instance.
