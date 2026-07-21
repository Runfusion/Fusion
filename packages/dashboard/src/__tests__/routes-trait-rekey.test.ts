// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseWorkflowIr, resolveReboundTarget, columnsWithFlag, normalizeColumnId } from "@fusion/core";
import type { WorkflowIr } from "@fusion/core";
import "@fusion/core"; // registers the built-in traits the trait resolvers read

import { decideIssueAction, legacyColumnLifecycleClass } from "../github-tracking-state.js";
import { sixColumnWorkflowIr } from "../../../engine/src/__tests__/fixtures/six-column-workflow-ir.js";

/*
FNXC:WorkflowColumns 2026-07-19-2c:10 (U12 / R2 / R11):
The operator-surface half of the cutover: every dashboard/API decision that used to key on the
closed six-id column enum must key on the TASK'S WORKFLOW instead.

These are deliberately pure-function tests over the seams U12 re-keyed, not route integration
tests. The value is in the DECISION (which column, which GitHub state, which label), and pinning it
directly is both faster and harder to fool than asserting through an Express stack whose store stub
would have to fake IR resolution anyway. Route wiring is exercised by the existing
`routes-task-*.test.ts` suites.

The fixture is U11's benchmark IR — the same object its acceptance runner drives — so "the editor
can build it" and "the runner can run it" are statements about ONE artifact, which is what R11 asks
for.
*/

const BENCHMARK_IR = sixColumnWorkflowIr();

describe("U12: column ids stay open across operator surfaces", () => {
  /*
  The defect this pins: the dashboard ran every ingested task through `normalizeColumn`, which
  keeps only the six legacy ids and rewrites everything else to `triage`. A card in a custom
  `merging` column rendered in Triage and dragging it appeared to do nothing.
  */
  it("preserves a novel column id instead of coercing it to a legacy one", () => {
    expect(normalizeColumnId("merging")).toBe("merging");
    expect(normalizeColumnId("ideas")).toBe("ideas");
    // Structurally unusable values still fall back — that is the only coercion left.
    expect(normalizeColumnId("")).toBe("triage");
    expect(normalizeColumnId(undefined)).toBe("triage");
    expect(normalizeColumnId(null, "todo")).toBe("todo");
  });

  it("resolves lifecycle move targets from the workflow, not from literals", () => {
    // Rebound (retry / reset / unassign) targets the hold column...
    expect(resolveReboundTarget(BENCHMARK_IR)).toBe("todo");
    // ...execution targets the wip column, and intake is its own thing.
    expect(columnsWithFlag(BENCHMARK_IR, "countsTowardWip")[0]).toBe("in-progress");
    expect(columnsWithFlag(BENCHMARK_IR, "intake")[0]).toBe("ideas");

    /*
    The point of deriving rather than hardcoding: a workflow with NO `todo` and NO `triage` still
    resolves a real destination. Under the old literals the operator's Retry button either threw
    or parked the card in a column the workflow never declared.
    */
    const renamed = parseWorkflowIr({
      version: "v2",
      name: "renamed-lifecycle",
      columns: [
        { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
        { id: "queue", name: "Queue", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "building", name: "Building", traits: [{ trait: "wip" }] },
        { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "inbox" },
        { id: "build", kind: "prompt", column: "building", config: { seam: "execute" } },
        { id: "end", kind: "end", column: "shipped" },
      ],
      edges: [{ from: "start", to: "build" }, { from: "build", to: "end", condition: "success" }],
    } as never) as WorkflowIr;

    expect(resolveReboundTarget(renamed)).toBe("queue");
    expect(columnsWithFlag(renamed, "countsTowardWip")[0]).toBe("building");
    expect(columnsWithFlag(renamed, "intake")[0]).toBe("inbox");
  });
});

describe("U12: GitHub issue state keys on complete/archived traits", () => {
  /** Classify by TRAIT, the way the re-keyed caller does, rather than by literal id. */
  const classifyByTrait = (ir: WorkflowIr) => {
    const complete = new Set(columnsWithFlag(ir, "complete"));
    const archived = new Set(columnsWithFlag(ir, "archived"));
    return (columnId: string) => ({ complete: complete.has(columnId), archived: archived.has(columnId) });
  };

  it("closes the issue when a card reaches a workflow's own complete column", () => {
    const classify = classifyByTrait(BENCHMARK_IR);
    // The benchmark's complete column happens to be `done`, but the decision is trait-driven:
    expect(decideIssueAction("merging", "done", classify)).toEqual({
      action: "close",
      stateReason: "completed",
    });
    // A move between non-terminal columns is not a GitHub event at all.
    expect(decideIssueAction("in-review", "merging", classify)).toBeNull();
  });

  it("closes on a RENAMED complete column, which the literal mapping missed entirely", () => {
    const renamed = parseWorkflowIr({
      version: "v2",
      name: "renamed-terminal",
      columns: [
        { id: "building", name: "Building", traits: [{ trait: "wip" }] },
        { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
        { id: "dropped", name: "Dropped", traits: [{ trait: "archived" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "building" },
        { id: "end", kind: "end", column: "shipped" },
      ],
      edges: [{ from: "start", to: "end" }],
    } as never) as WorkflowIr;
    const classify = classifyByTrait(renamed);

    expect(decideIssueAction("building", "shipped", classify)).toEqual({
      action: "close",
      stateReason: "completed",
    });
    expect(decideIssueAction("building", "dropped", classify)).toEqual({
      action: "close",
      stateReason: "not_planned",
    });
    expect(decideIssueAction("shipped", "building", classify)).toEqual({
      action: "reopen",
      stateReason: "reopened",
    });
    expect(decideIssueAction("dropped", "shipped", classify)).toEqual({
      action: "reopen",
      stateReason: "reopened",
    });

    // The regression this replaces: with the legacy literal classifier, none of it fires.
    expect(decideIssueAction("building", "shipped", legacyColumnLifecycleClass)).toBeNull();
  });

  it("keeps the default workflow byte-identical under the default classifier", () => {
    expect(decideIssueAction("in-review", "done")).toEqual({ action: "close", stateReason: "completed" });
    expect(decideIssueAction("done", "archived")).toEqual({ action: "close", stateReason: "completed" });
    expect(decideIssueAction("todo", "archived")).toEqual({ action: "close", stateReason: "not_planned" });
    expect(decideIssueAction("archived", "done")).toEqual({ action: "reopen", stateReason: "reopened" });
    expect(decideIssueAction("done", "todo")).toEqual({ action: "reopen", stateReason: "reopened" });
    expect(decideIssueAction("todo", "in-progress")).toBeNull();
    expect(decideIssueAction("archived", "archived")).toBeNull();
  });
});

/*
FNXC:WorkflowColumns 2026-07-19-2c:20 (U12 / R11 first half):
EDITOR BUILDABILITY. R11 asks that the 6-column benchmark be constructible in the workflow editor,
not merely hand-written as a test fixture. The editor's save path validates through
`parseWorkflowIr` (via `validateWorkflowIrDryRun`), so parsing the benchmark IR and getting back a
usable v2 graph IS the buildability claim — and because U11's runner drives this exact object, the
saved artifact is provably byte-usable by the runtime.
*/
describe("U12: the 6-column benchmark is editor-buildable (R11)", () => {
  it("passes save validation and round-trips its columns, traits, nodes and caps", () => {
    const parsed = parseWorkflowIr(BENCHMARK_IR as never) as WorkflowIr & {
      columns: Array<{ id: string; traits: Array<{ trait: string }> }>;
      nodes: Array<{ id: string; column?: string; config?: Record<string, unknown> }>;
      edges: Array<{ from: string; to: string; condition?: string; kind?: string }>;
    };

    expect(parsed.version).toBe("v2");
    // Six columns, in the operator's documented order.
    expect(parsed.columns.map((c) => c.id)).toEqual([
      "ideas",
      "todo",
      "in-progress",
      "in-review",
      "merging",
      "done",
    ]);
    // Each column kept the traits the contract assigns it.
    const traitsOf = (id: string) =>
      parsed.columns.find((c) => c.id === id)!.traits.map((t) => t.trait).sort();
    expect(traitsOf("ideas")).toEqual(["intake"]);
    expect(traitsOf("todo")).toEqual(["hold", "reset-on-entry"]);
    expect(traitsOf("in-progress")).toEqual(["abort-on-exit", "timing", "wip"]);
    expect(traitsOf("in-review")).toEqual(["merge-blocker", "stall-detection"]);
    // Merging carries the human gate — the operator contract's settled placement.
    expect(traitsOf("merging")).toEqual(["human-review", "merge"]);
    expect(traitsOf("done")).toEqual(["complete"]);

    // Review nodes sit in the hold column (pre-release Plan Review) and In-review respectively.
    const nodeColumn = (id: string) => parsed.nodes.find((n) => n.id === id)?.column;
    expect(nodeColumn("plan-review")).toBe("todo");
    expect(nodeColumn("code-review")).toBe("in-review");
    // The remediation node sits in In-progress — that placement is what makes the REVISE
    // round-trip a visible backward column move rather than an in-place retry.
    expect(nodeColumn("code-review-remediation")).toBe("in-progress");

    // The remediation edges survive as rework edges (the only legal cycles).
    const reworkEdges = parsed.edges.filter((e) => e.kind === "rework");
    expect(reworkEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "plan-replan", to: "plan-review" }),
        expect.objectContaining({ from: "code-review-remediation", to: "code-review" }),
      ]),
    );

    // Per-node caps are workflow config and survive the round trip.
    const configOf = (id: string) => parsed.nodes.find((n) => n.id === id)?.config ?? {};
    expect(configOf("plan-review").maxReworkCycles).toBe(1);
    expect(configOf("code-review").maxReworkCycles).toBe(3);
  });

  /*
  The negative case R11 asks for. "Node references a missing column" must be REJECTED at save, not
  silently accepted and then discovered at runtime when the boundary tries to move a card into a
  column that does not exist.
  */
  it("rejects a node pointing at a column the workflow does not declare", () => {
    const broken = {
      ...(BENCHMARK_IR as unknown as Record<string, unknown>),
      nodes: (BENCHMARK_IR as unknown as { nodes: Array<Record<string, unknown>> }).nodes.map((n) =>
        n.id === "merge-attempt" ? { ...n, column: "nonexistent-column" } : n,
      ),
    };

    expect(() => parseWorkflowIr(broken as never)).toThrow(
      /references undefined column 'nonexistent-column'/,
    );
  });

  it("still rejects the invalid graph when every column id is novel", () => {
    const broken = {
      version: "v2",
      name: "novel-ids",
      columns: [{ id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] }],
      nodes: [
        { id: "start", kind: "start", column: "inbox" },
        { id: "work", kind: "prompt", column: "not-declared" },
        { id: "end", kind: "end", column: "inbox" },
      ],
      edges: [{ from: "start", to: "work" }, { from: "work", to: "end", condition: "success" }],
    };
    expect(() => parseWorkflowIr(broken as never)).toThrow(/references undefined column/);
  });
});
