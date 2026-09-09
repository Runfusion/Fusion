/*
FNXC:WorkflowLifecycleTraits 2026-07-19-06:20 (U6 / KTD-10 / R8):
Unit coverage for the trait→column primitives that self-healing's trait re-key is
built on. The builtin:coding cases are the R8 evidence — every trait resolves to
exactly the legacy column id the old literals used, so a re-key keyed on these is
byte-identical on the default workflow. The custom cases prove KTD-10 fallback.
*/
import { describe, expect, it } from "vitest";
import "../builtin-traits.js"; // register built-in traits
import { BUILTIN_CODING_WORKFLOW_IR } from "../workflows/builtin-coding-workflow-ir.js";
import { columnsWithFlag, columnHasFlag, resolveReboundTarget, resolveCompleteColumn, resolveMergeOrchestrationColumn, resolveLifecycleColumns, resolveTaskLifecycleColumns, resolveReviewColumns, resolveTerminalColumns} from "../workflows/workflow-lifecycle-traits.js";
import { BUILTIN_CODING_IDEAS_WORKFLOW_IR } from "../workflows/builtin-coding-ideas-workflow-ir.js";
import type { WorkflowIr } from "../workflows/workflow-ir-types.js";
import { getTraitRegistry } from "../workflows/trait-registry.js";

describe("columnsWithFlag — builtin:coding trait→columnIds (R8)", () => {
  const ir = BUILTIN_CODING_WORKFLOW_IR;
  it("maps each lifecycle trait to exactly the legacy column ids", () => {
    expect(columnsWithFlag(ir, "countsTowardWip")).toEqual(["in-progress"]);
    expect(columnsWithFlag(ir, "hold")).toEqual(["todo"]);
    expect(columnsWithFlag(ir, "intake")).toEqual(["triage"]);
    expect(columnsWithFlag(ir, "mergeOrchestration")).toEqual(["in-review"]);
    expect(columnsWithFlag(ir, "complete")).toEqual(["done"]);
  });

  it("columnHasFlag agrees with the literal columns", () => {
    expect(columnHasFlag(ir, "in-progress", "countsTowardWip")).toBe(true);
    expect(columnHasFlag(ir, "todo", "hold")).toBe(true);
    expect(columnHasFlag(ir, "in-review", "mergeOrchestration")).toBe(true);
    expect(columnHasFlag(ir, "done", "complete")).toBe(true);
    expect(columnHasFlag(ir, "in-progress", "complete")).toBe(false);
    expect(columnHasFlag(ir, "nonexistent", "hold")).toBe(false);
  });
});

describe("resolveReboundTarget — KTD-10 ordering", () => {
  it("targets the hold column for builtin:coding (== legacy 'todo', R8 byte-identical)", () => {
    expect(resolveReboundTarget(BUILTIN_CODING_WORKFLOW_IR)).toBe("todo");
  });

  it("prefers hold, then intake, then the first column", () => {
    const holdWf: WorkflowIr = {
      version: "v2", name: "h",
      columns: [
        { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
        { id: "backlog", name: "Backlog", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "wip", name: "WIP", traits: [{ trait: "wip" }] },
      ],
      nodes: [{ id: "start", kind: "start", column: "inbox" }],
      edges: [],
    } as WorkflowIr;
    expect(resolveReboundTarget(holdWf)).toBe("backlog"); // hold beats intake
  });

  it("falls back to the intake column when there is no hold column (custom workflow)", () => {
    const noHold: WorkflowIr = {
      version: "v2", name: "n",
      columns: [
        { id: "ideas", name: "Ideas", traits: [{ trait: "intake" }] },
        { id: "doing", name: "Doing", traits: [{ trait: "wip" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [{ id: "start", kind: "start", column: "ideas" }],
      edges: [],
    } as WorkflowIr;
    expect(resolveReboundTarget(noHold)).toBe("ideas");
  });

  it("falls back to the first column when there is neither hold nor intake", () => {
    const bare: WorkflowIr = {
      version: "v2", name: "b",
      columns: [
        { id: "first", name: "First", traits: [] },
        { id: "second", name: "Second", traits: [{ trait: "wip" }] },
      ],
      nodes: [{ id: "start", kind: "start", column: "first" }],
      edges: [],
    } as WorkflowIr;
    expect(resolveReboundTarget(bare)).toBe("first");
  });

  it("returns undefined for a column-less (v1) IR (caller keeps its literal fallback)", () => {
    const v1: WorkflowIr = { version: "v1", name: "v1", nodes: [{ id: "start", kind: "start" }], edges: [] } as WorkflowIr;
    expect(resolveReboundTarget(v1)).toBeUndefined();
  });
});

describe("resolveCompleteColumn / resolveMergeOrchestrationColumn — U7", () => {
  it("resolves to done / in-review for builtin:coding (R8 byte-identical)", () => {
    expect(resolveCompleteColumn(BUILTIN_CODING_WORKFLOW_IR)).toBe("done");
    expect(resolveMergeOrchestrationColumn(BUILTIN_CODING_WORKFLOW_IR)).toBe("in-review");
  });

  it("resolves a custom workflow's own complete + merge-orchestration columns (benchmark shape)", () => {
    const benchmark: WorkflowIr = {
      version: "v2", name: "benchmark",
      columns: [
        { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
        { id: "in-review", name: "In review", traits: [{ trait: "human-review" }] },
        { id: "merging", name: "Merging", traits: [{ trait: "merge" }, { trait: "merge-blocker" }] },
        { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
      ],
      nodes: [{ id: "start", kind: "start", column: "todo" }],
      edges: [],
    } as WorkflowIr;
    expect(resolveCompleteColumn(benchmark)).toBe("shipped");
    expect(resolveMergeOrchestrationColumn(benchmark)).toBe("merging");
  });

  it("returns undefined when the workflow declares no complete / merge column", () => {
    const bare: WorkflowIr = {
      version: "v2", name: "b",
      columns: [{ id: "only", name: "Only", traits: [] }],
      nodes: [{ id: "start", kind: "start", column: "only" }],
      edges: [],
    } as WorkflowIr;
    expect(resolveCompleteColumn(bare)).toBeUndefined();
    expect(resolveMergeOrchestrationColumn(bare)).toBeUndefined();
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-27-09:20 (U1 — workflow-owned lifecycle):
Coverage for THE lifecycle-column resolution seam that Phases B–D convert ~207
hardcoded column literals onto. Two properties matter more than the happy path:

  1. ID-INDEPENDENCE. The renamed-workflow case is the real assertion — it fails
     if the resolver ever falls back to a legacy literal, which is exactly the
     silent-guard failure mode this program exists to remove.
  2. NO SUBSTITUTION. A workflow with no hold column must resolve `hold:
     undefined`, not "the nearest thing". Substituting would turn "this workflow
     has no capacity hold" into a wrong-but-plausible answer at 200 call sites.
*/
describe("resolveLifecycleColumns — U1 trait→role resolution", () => {
  it("resolves the default coding workflow's roles to the legacy column ids", () => {
    const columns = resolveLifecycleColumns(BUILTIN_CODING_WORKFLOW_IR);
    expect(columns).toEqual({
      intake: "triage",
      hold: "todo",
      wip: "in-progress",
      review: "in-review",
      complete: "done",
    });
  });

  it("resolves Coding (Ideas) to its OWN intake column — id-independence, not a literal", () => {
    const columns = resolveLifecycleColumns(BUILTIN_CODING_IDEAS_WORKFLOW_IR);
    expect(columns?.intake).toBe("ideas");
    // Ideas keeps `todo` as its hold column (R11's in-tree compatibility case),
    // so this pair proves the resolver reads traits rather than assuming the
    // default workflow's intake/hold pairing.
    expect(columns?.hold).toBe("todo");
  });

  it("resolves a fully renamed workflow by trait, never by id", () => {
    const renamed: WorkflowIr = {
      version: "v2", name: "editorial",
      columns: [
        { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
        { id: "drafting", name: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "writing", name: "Writing", traits: [{ trait: "wip" }] },
        { id: "editorial-review", name: "Editorial review", traits: [{ trait: "merge" }] },
        { id: "published", name: "Published", traits: [{ trait: "complete" }] },
      ],
      nodes: [{ id: "start", kind: "start", column: "backlog" }],
      edges: [],
    } as WorkflowIr;
    expect(resolveLifecycleColumns(renamed)).toEqual({
      intake: "backlog",
      hold: "drafting",
      wip: "writing",
      review: "editorial-review",
      complete: "published",
    });
  });

  it("leaves an absent role undefined instead of substituting an unrelated column", () => {
    const noHold: WorkflowIr = {
      version: "v2", name: "no-hold",
      columns: [
        { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
        { id: "doing", name: "Doing", traits: [{ trait: "wip" }] },
        { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
      ],
      nodes: [{ id: "start", kind: "start", column: "inbox" }],
      edges: [],
    } as WorkflowIr;
    const columns = resolveLifecycleColumns(noHold);
    expect(columns).toBeDefined();
    expect(columns?.hold).toBeUndefined();
    // The nearby columns are still resolved — absence is per-role, not per-workflow.
    expect(columns?.intake).toBe("inbox");
    expect(columns?.wip).toBe("doing");
    expect(columns?.complete).toBe("shipped");
  });

  it("returns undefined (not a struct of undefineds) for a v1 / column-less IR", () => {
    // The caller must be able to distinguish "no hold column declared" from
    // "no column vocabulary at all"; only the latter licenses skip-and-log.
    const v1 = { version: "v1", name: "legacy", nodes: [], edges: [] } as unknown as WorkflowIr;
    expect(resolveLifecycleColumns(v1)).toBeUndefined();
  });

  it("picks the FIRST column carrying a role when several do", () => {
    const twoHolds: WorkflowIr = {
      version: "v2", name: "two-holds",
      columns: [
        { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
        { id: "hold-a", name: "Hold A", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "hold-b", name: "Hold B", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      ],
      nodes: [{ id: "start", kind: "start", column: "inbox" }],
      edges: [],
    } as WorkflowIr;
    expect(resolveLifecycleColumns(twoHolds)?.hold).toBe("hold-a");
  });
});

describe("resolveTaskLifecycleColumns — U1 store-aware form", () => {
  function makeStore(overrides: Partial<Record<string, unknown>> = {}) {
    const definitionReads: string[] = [];
    const store = {
      getTaskWorkflowSelection: (taskId: string) => ({ workflowId: taskId === "T-IDEAS" ? "wf-ideas" : "wf-custom" }),
      getWorkflowDefinition: async (workflowId: string) => {
        definitionReads.push(workflowId);
        return {
          id: workflowId,
          ir: workflowId === "wf-ideas" ? BUILTIN_CODING_IDEAS_WORKFLOW_IR : BUILTIN_CODING_WORKFLOW_IR,
        };
      },
      ...overrides,
    };
    return { store: store as never, definitionReads };
  }

  it("resolves a task's roles through its workflow selection", async () => {
    const { store } = makeStore();
    await expect(resolveTaskLifecycleColumns(store, "T-1")).resolves.toEqual({
      intake: "triage", hold: "todo", wip: "in-progress",
      review: "in-review", complete: "done",
    });
  });

  it("resolves each workflow's IR ONCE per pass when the caller shares a cache", async () => {
    // The reason the cache is caller-owned: a sweep over N cards on one workflow
    // must read one IR, not N. Assert on the resolver's own read count.
    const { store, definitionReads } = makeStore();
    const cache = new Map();
    await resolveTaskLifecycleColumns(store, "T-1", cache);
    await resolveTaskLifecycleColumns(store, "T-2", cache);
    await resolveTaskLifecycleColumns(store, "T-3", cache);
    expect(definitionReads).toEqual(["wf-custom"]);
  });

  it("reads each DISTINCT workflow once, so a mixed-workflow sweep stays correct", async () => {
    const { store, definitionReads } = makeStore();
    const cache = new Map();
    const first = await resolveTaskLifecycleColumns(store, "T-1", cache);
    const ideas = await resolveTaskLifecycleColumns(store, "T-IDEAS", cache);
    expect(first?.intake).toBe("triage");
    expect(ideas?.intake).toBe("ideas");
    expect(definitionReads).toEqual(["wf-custom", "wf-ideas"]);
  });

  it("returns undefined when the workflow resolves to no column vocabulary", async () => {
    const { store } = makeStore({
      getWorkflowDefinition: async () => ({ id: "wf-v1", ir: { version: "v1", name: "legacy", nodes: [], edges: [] } }),
    });
    await expect(resolveTaskLifecycleColumns(store, "T-1")).resolves.toBeUndefined();
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-07:10 (the arity contract, pinned):
`LifecycleColumns` names ONE column per role even when the workflow declares several — nothing
validates that a trait appears at most once, and `resolveLifecycleColumns` takes the head of
`columnsWithFlag`.

This is asserted rather than left in the doc comment because two production bugs came from assuming
otherwise (PR #2713): a task in a SECOND terminal column was rejected with a 409, and a task in a
human-review lane split from the merge lane was classified as outside review entirely. Both read
like ordinary conversions.

The point of the pair below is the CONTRAST: the struct is safe for "where should this card go" and
unsafe for "is this card already there". A reader who only sees the first assertion learns the wrong
lesson.
*/
describe("LifecycleColumns arity — one id per role, even when several qualify", () => {
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-07:40 (PR #2721 review — greptile, and the premise was
  wrong):
  Uses `complete`, NOT `intake`. My first version demonstrated the arity gap with two intake lanes
  and bypassed typing with `as never` to build it — but `validateColumnTraits` raises
  `multiple-intake-columns`, so that workflow shape is REJECTED by the product. The test would have
  stayed green while documenting something that cannot exist, which is worse than not testing it.

  `complete` genuinely repeats: there is no uniqueness rule for it, nor for `hold`,
  `countsTowardWip`, `mergeBlocker` or `humanReview`. Only `intake` is validated unique. That is the
  real boundary, and it means `intake` comparisons are safe by equality while every other role's are
  not — which narrows the call sites at risk rather than widening them.
  */
  const twoTerminalsIr: WorkflowIr = {
    version: "v2",
    name: "two-terminals",
    columns: [
      { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
      { id: "building", name: "Building", traits: [{ trait: "wip" }] },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
      { id: "released", name: "Released", traits: [{ trait: "complete" }] },
    ],
    nodes: [{ id: "start", kind: "start", column: "backlog" }, { id: "end", kind: "end", column: "shipped" }],
    edges: [{ from: "start", to: "end" }],
  } as WorkflowIr;

  it("is a workflow the product actually ACCEPTS — the premise this rests on", () => {
    /*
    Asserted, not assumed. My first version of these cases used two INTAKE columns, which
    `validateColumnTraits` rejects with `multiple-intake-columns` — so it documented a shape that
    cannot exist while staying green. Proving the fixture is valid is what makes the arity gap below
    a real hazard rather than a hypothetical one.
    */
    const violations = getTraitRegistry().validateColumnTraits(twoTerminalsIr.columns as never);
    expect(violations.filter((v) => v.severity === "error")).toEqual([]);
  });

  it("reports only ONE complete column — the second is invisible to the struct", () => {
    const lifecycle = resolveLifecycleColumns(twoTerminalsIr);
    expect(lifecycle).toBeDefined();
    expect(["shipped", "released"]).toContain(lifecycle!.complete);
  });

  it("so a MEMBERSHIP test against it misses the second column — use columnsWithFlag instead", () => {
    const lifecycle = resolveLifecycleColumns(twoTerminalsIr)!;
    const bothTerminals = columnsWithFlag(twoTerminalsIr, "complete");

    // Both are genuinely terminal columns.
    expect(bothTerminals).toHaveLength(2);
    expect(bothTerminals).toEqual(expect.arrayContaining(["shipped", "released"]));

    // Exactly one fails an equality check against the struct — the shipped-bug shape from PR #2713.
    const missed = bothTerminals.find((id) => id !== lifecycle.complete)!;
    expect(missed).toBeDefined();
    expect(missed === lifecycle.complete).toBe(false);
    // The membership form gets it right.
    expect(bothTerminals.includes(missed)).toBe(true);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-05:20:
The set-shaped answer to "is this card ALREADY in a review lane", which four consumers each invented
separately before this existed (#2713, #2722, #2723, #2728). Both directions are asserted, because the
whole reason it exists is that the single-id `.review` silently answers a different question.
*/
describe("resolveReviewColumns", () => {
  const ir = (columns: Array<{ id: string; traits: Array<{ trait: string }> }>) =>
    ({ version: "v2", id: "wf", name: "wf", columns: columns.map((c) => ({ ...c, name: c.id })), nodes: [], edges: [] }) as never;

  it("includes a lane carrying human-review WITHOUT the merge trait", () => {
    /* The #2722 defect: `.review` reads mergeOrchestration only, so this lane resolved to nothing and
       the review notification never fired on a renamed board. */
    const columns = ir([
      { id: "building", traits: [{ trait: "wip" }] },
      { id: "signoff", traits: [{ trait: "human-review" }] },
    ]);

    expect(resolveReviewColumns(columns)).toEqual(["signoff"]);
    expect(resolveLifecycleColumns(columns)?.review).toBeUndefined();
  });

  it("includes EVERY review lane, not just the first", () => {
    const columns = ir([
      { id: "merge-gate", traits: [{ trait: "merge" }] },
      { id: "signoff", traits: [{ trait: "human-review" }] },
    ]);

    expect(new Set(resolveReviewColumns(columns))).toEqual(new Set(["merge-gate", "signoff"]));
  });

  it("is MONOTONIC: a lane with both traits stays in the set", () => {
    /* The #2723 review round argued for excluding this. Adding a trait must never REMOVE a lane —
       otherwise a card stops counting as in review because its column gained an unrelated capability. */
    const columns = ir([
      { id: "merge-gate", traits: [{ trait: "merge" }] },
      { id: "signoff", traits: [{ trait: "merge" }, { trait: "human-review" }] },
    ]);

    expect(resolveReviewColumns(columns)).toContain("signoff");
  });

  it("does not duplicate a lane that carries several review traits", () => {
    const columns = ir([{ id: "signoff", traits: [{ trait: "merge" }, { trait: "human-review" }] }]);

    expect(resolveReviewColumns(columns)).toEqual(["signoff"]);
  });

  it("returns EMPTY when no lane reviews, so callers keep their own fallback", () => {
    /* Deliberately not defaulting to `in-review` here: the fallback belongs to the caller, which knows
       whether refusing or admitting is the safe direction for its own guard. */
    expect(resolveReviewColumns(ir([{ id: "building", traits: [{ trait: "wip" }] }]))).toEqual([]);
  });

  it("is BROADER than `.review` on a board with two merge lanes — the distinction callers must choose between", () => {
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-11:30:
    Pinned because one NAME was answering two questions, and the difference only appears on a board that
    declares `mergeOrchestration` twice — which no default lineage does.

      BROAD  (this helper)                every merge lane, plus mergeBlocker/humanReview lanes.
                                          Safe where over-admission is harmless: notifications, badges.
      NARROW (`resolveLifecycleColumns`)  the FIRST merge lane only — what the executor, scheduler and
                                          project-engine act on.

    A caller that admits on the broad set and then MOVES the card moves cards the engine does not consider
    in review. `register-task-workflow-routes.ts` keeps its own narrower resolver for that reason (#2723);
    this test is what stops someone "consolidating" the two and silently re-admitting the second lane.
    */
    const twoMergeLanes = ir([
      { id: "building", traits: [{ trait: "wip" }] },
      { id: "merge-gate", traits: [{ trait: "merge" }] },
      { id: "second-gate", traits: [{ trait: "merge" }] },
    ]);

    expect(resolveReviewColumns(twoMergeLanes)).toEqual(["merge-gate", "second-gate"]);
    // The engine's answer is ONE lane, and it is the first.
    expect(resolveLifecycleColumns(twoMergeLanes)?.review).toBe("merge-gate");
  });

  it("agrees with the shipped coding workflow", () => {
    expect(resolveReviewColumns(BUILTIN_CODING_WORKFLOW_IR)).toContain("in-review");
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-19:20:
A v1 graph upgraded to v2 carries `traits: []` on every synthesized column (`synthesizeDefaultColumns`
in workflow-ir.ts — placement only, by design). So every role resolver answers "nothing" for a board
whose lanes are in fact the legacy ones.

This is pinned because the shape is INDISTINGUISHABLE at the call site from a hand-written v2 workflow
that genuinely declares no such lane, and the two want opposite handling. A guard that reads empty as
"no such lane" is right for the second and withdraws every role at once for the first.
*/
describe("a v1-upgraded IR resolves to NO roles — the other meaning of empty", () => {
  const v1Upgraded = {
    version: "v2",
    name: "upgraded",
    columns: ["todo", "in-progress", "in-review", "done"].map((id) => ({ id, name: id, traits: [] })),
    nodes: [],
    edges: [],
  } as never;

  it("returns no lifecycle roles at all", () => {
    expect(resolveLifecycleColumns(v1Upgraded)).toEqual({});
  });

  it("returns an EMPTY review set, not the legacy lane", () => {
    expect(resolveReviewColumns(v1Upgraded)).toEqual([]);
  });

  it("returns an EMPTY wip set", () => {
    expect(columnsWithFlag(v1Upgraded, "countsTowardWip")).toEqual([]);
  });

  it("still yields the legacy completion lane because that resolver keeps its own fallback", () => {
    expect(resolveTerminalColumns(v1Upgraded)).toEqual(["done"]);
  });
});
