/*
FNXC:WorkflowLifecycleTraits 2026-07-19-06:20 (U6 / KTD-10 / R8):
Unit coverage for the trait→column primitives that self-healing's trait re-key is
built on. The builtin:coding cases are the R8 evidence — every trait resolves to
exactly the legacy column id the old literals used, so a re-key keyed on these is
byte-identical on the default workflow. The custom cases prove KTD-10 fallback.
*/
import { describe, expect, it } from "vitest";
import "../builtin-traits.js"; // register built-in traits
import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import { columnsWithFlag, columnHasFlag, resolveReboundTarget, resolveCompleteColumn, resolveMergeOrchestrationColumn, resolveLifecycleColumns, resolveTaskLifecycleColumns } from "../workflow-lifecycle-traits.js";
import { BUILTIN_CODING_IDEAS_WORKFLOW_IR } from "../builtin-coding-ideas-workflow-ir.js";
import type { WorkflowIr } from "../workflow-ir-types.js";

describe("columnsWithFlag — builtin:coding trait→columnIds (R8)", () => {
  const ir = BUILTIN_CODING_WORKFLOW_IR;
  it("maps each lifecycle trait to exactly the legacy column ids", () => {
    expect(columnsWithFlag(ir, "countsTowardWip")).toEqual(["in-progress"]);
    expect(columnsWithFlag(ir, "hold")).toEqual(["todo"]);
    expect(columnsWithFlag(ir, "intake")).toEqual(["triage"]);
    expect(columnsWithFlag(ir, "mergeOrchestration")).toEqual(["in-review"]);
    expect(columnsWithFlag(ir, "complete")).toEqual(["done"]);
    expect(columnsWithFlag(ir, "archived")).toEqual(["archived"]);
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
      archived: "archived",
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
        { id: "shelved", name: "Shelved", traits: [{ trait: "archived" }] },
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
      archived: "shelved",
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
    expect(columns?.archived).toBeUndefined();
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
      review: "in-review", complete: "done", archived: "archived",
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
