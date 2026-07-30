---
category: best-practices
module: "@fusion/engine, @fusion/core"
date: 2026-07-30
problem_type: verification_pattern
component: workflow-graph
severity: high
applies_when:
  - "Wiring behavior into a seam, handler, or hook and assuming it executes"
  - "Writing a ratchet or guard that scans source text"
  - "Concluding from instrumentation that a code path was not reached"
  - "Converting a lifecycle guard and getting a green test on the first try"
  - "About to report a tool, helper, or teammate's code as defective"
  - "Resolving a task's workflow when the store may not be able to name it"
tags:
  - verification
  - dead-code
  - ratchets
  - workflow-seams
  - instrumentation
related_components:
  - workflow_graph
  - executor
  - workflow_ir_resolver
---

# Proving a code path actually runs

Six findings from U8 of the workflow-owned-lifecycle program. Findings 1-5 are cases where code
was correct, type-checked, tested, reviewed, merged — and never executed, or was verified by
something that could not fail. They share a root: **we confirmed a property of the source rather
than of the run.** Finding 6 is the mirror image, and the one this document's own author broke
most: claiming someone else's code is wrong without reading it.

## 1. Two handlers exist for prompt nodes; only one runs

`createDefaultNodeHandlers` selects the prompt-node handler like this:

```ts
const promptLike = deps?.primitives
  ? createPrimitivePromptLikeHandler(deps.primitives, runCustomNode)
  : createPromptLikeHandler(seams, runCustomNode);
```

`executeWorkflowGraph` **always** passes `primitives`. Both objects are handed to the graph
executor and only one is consulted, so every `execute` / `step-execute` / `review` /
`review-handoff` / `merge` / `schedule` entry in `createAuthoritativeWorkflowSeams` is unreachable
for prompt nodes.

A lifecycle event announcement was wired into that seam and shipped in two PRs before anyone
noticed it had never fired. It type-checked. Its unit tests passed — because they called the seam
object directly, which a seam-level test always can.

**Rule:** when adding behavior to one of a pair of interchangeable implementations, assert
*behaviourally* which one production selects — build the real handler map from spied
implementations and check which spy ran. `createPrimitivePromptLikeHandler`'s parity with the seam
list is what makes preferring it safe; a seam it does not handle falls through to the custom-node
runner and is treated as a custom node.

## 2. A negative instrumentation result is worthless without a control

Instrumenting the seam produced no output for a run that demonstrably visited
`steps#0:step-execute`. That is only evidence if writes from that module are known to be visible
under the harness. A `process.stderr.write` at module load of the same file appeared exactly once
in the same run — *then* the negative meant something.

**Rule:** before concluding "this never runs", prove your probe can be seen. One control line.
Without it you cannot distinguish an unexecuted path from swallowed output, and the two lead to
opposite conclusions.

## 3. Source-string ratchets prove syntax, not behavior

Three guards written during this unit were torn down in review for the same reason. The sharpest
case: a ratchet asserting `deps?.primitives ? createPrimitivePromptLikeHandler` appears in source.
That string survives an inverted dispatch, an extracted helper, or a reordered condition — so the
ratchet stays green through exactly the regression it exists to catch. Guarding a
never-executed-code bug with a source search reproduces the bug one level up.

Measured: replacing the dispatch with the unconditional legacy handler **failed** the behavioural
version and **passed** the textual one.

**Rules:**

- Prefer a behavioural assertion. Where only source can be checked (a call site inside a 3k-line
  method that cannot be driven), say so in the test and keep the assertion structural rather than
  dressing it as coverage.
- Use the AST, not regex, when scanning source. A brace inside a string literal truncated an
  extraction to 13 lines; every count under it read zero, which is a *passing* ratchet.
- Guard the guard: assert the thing being scanned is non-trivial (a method body's line count, a
  scanned-file count, that the enum under test equals the resolver's accepted set).
- Anchor by index, never a character window. A 400-character lookaround admitted unrelated matches
  and rejected valid ones separated by an added comment.

## 4. A green test on the first try, on a path with no prior coverage, is a warning

Two conversions were reverted in one day because their tests **passed with the change reverted**.

- Negative assertions (`expect(x).not.toHaveBeenCalled()`) pass trivially when the method returns
  early. `recoverCompletedTask` has seven guards before the converted line; the fixture must
  satisfy all of them — notably supplying a satisfied `workflowStepResults` so the run does not
  divert into graph re-entry.
- A test that ends a graph walk on the node it is asserting about lets `graphFailureValue`'s own
  resolution answer first, so the backward walk under test never runs.

**Rule:** revert your change and watch the test fail. If it cannot fail, you have written a
description, not a test. This check caught a dead code path, a vacuous ratchet, and a vacuous
conversion test in a single unit — each of which was otherwise green and ready to merge.

## 5. A named workflow selection is not a resolved one

`resolveWorkflowIrForTask` returns the default coding IR when the selection read throws, when the
store reports no selection (the synchronous PostgreSQL path does this deliberately), and when
`resolveWorkflowIrById` cannot load or parse the definition. Callers cannot tell any of these from
a genuine selection.

This decides correctness for lifecycle-column work: post-#2515 the default lineage declares one
Planning column and no `triage`, so a caller that trusts a *guessed* resolution and drops its
legacy compat silently stops matching `builtin:legacy-coding` cards. The guard does not error —
it simply never fires, and the literal is gone so no census finds it.

Provenance cannot be inferred from the returned value: a fallback IR and a valid id-less IR are
structurally identical. The resolver that knows must report it.

**Rule:** when a resolver degrades to a default, say so in the return value. Callers deciding
between "trust the workflow" and "keep legacy compat" need the difference, and every lifecycle
call site eventually does.

## 6. Read the implementation before claiming its output is wrong

The other five findings are about proving a claim. This one is about the claims we make against
*other people's* work, and it is the rule the author of this document broke three times in a
single day while writing it.

Each time the shape was identical: reconstruct a tool's behaviour from the outside, compare it to
the tool's actual output, find a difference, and report the tool as defective — without first
reading what the tool does.

- **The census.** Its `summarize()` counts `byColumnId` only for `kind === "column"`. A locally
  patched counter summed every finding carrying the literal, across `role`, `status` and
  `deliberate` too. That produced "13 vs 10, the census undercounts by three" — reported as a
  defect in the instrument the whole program had just adopted as authoritative. The three were
  exactly the ones it classifies correctly. Ten lines of `summarize()` would have prevented it.

- **`resolvePlannerLanesForTask`.** A probe with a `{ getTask }`-only store showed it returning
  the default lineage's vocabulary for an unresolvable selection, which was escalated across four
  messages as a live regression silently disabling two recovery paths. The file's own header had
  already reasoned it through and documented why that answer is correct; and `TaskStore`
  implements `getTaskWorkflowSelectionAsync`, which the resolver prefers — so real projects never
  take the path the probe forced. **A fixture is not a measurement of production.**

- **The `.column ===` census.** A receiver-specific grep reported a file as converted while guards
  survived in it under `from` and `originColumn`. Same error a step earlier: trusting a
  reconstruction of the thing rather than the thing.

**Rules:**

- Before reporting a tool, helper, or teammate's code as wrong, read its implementation and its
  header comment. On this codebase the reasoning is usually already written down, and the FNXC
  note frequently answers the exact objection.
- When a probe and the real system disagree, suspect the probe first. Ask what the probe had to
  stub to produce its result, and whether production ever supplies that shape.
- Retract precisely and immediately when wrong. A false defect report against shared
  infrastructure costs more than the bug would have: it sends other people to check something
  that was already correct, and it spends the credibility needed for the next report that is real.
