// @vitest-environment node

/*
FNXC:WorkflowResolvedColumns 2026-07-30-00:55 (batch-core):

"HAS THIS TASK LANDED?" — THE QUESTION THAT PICKS THE DIFF BOUNDARY.

The two diff routes chose between a MERGE-COMMIT diff (finished work, already on the integration
branch) and a LIVE-BRANCH diff by comparing `task.column === "done"`. On a renamed board a landed task
took the live-branch path, so its diff was computed against a branch that had been merged and usually
deleted — an empty or misleading diff for exactly the tasks an operator reviews after the fact.

`landedColumnsForTask` holds that decision, and now lives in `task-lifecycle-lanes.ts` — shared with the
GitHub/GitLab source-issue commenters and the GitLab backfill reconciler, which all asked it separately. Testing the seam rather than the routes is deliberate:
an HTTP fixture over these route registrars starts background work and hangs (measured while
converting `register-git-github.ts`), and mocking git + the GitHub client to get past it is the
mock-the-world shell FN-5048 tells us not to add.

Both roles count as landed, and both fallback directions are pinned, because they fail differently:
an unresolvable workflow and a v1-upgraded one (every synthesized column carries `traits: []`, so the
resolved set is EMPTY even though the columns exist) must BOTH keep the legacy pair. Reading empty as
"this board has no complete lane" would send every pre-v2 project down the live-branch path.
*/
import { describe, expect, it, vi } from "vitest";
import "@fusion/core"; // registers the built-in column traits so flags resolve
import { landedColumnsForTask, completeColumnsForTask, archivedColumnsForTask, wipColumnsForTask, preWipColumnsForTask } from "../task-lifecycle-lanes.js";

function storeWith(ir: unknown, workflowId = "wf") {
  const selection = { workflowId, stepIds: [] as string[] };
  return {
    getTaskWorkflowSelection: () => selection,
    getTaskWorkflowSelectionAsync: async () => selection,
    getWorkflowDefinition: async () => (ir === undefined ? undefined : { id: workflowId, ir }),
  } as never;
}

const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    { id: "attic", name: "Attic", traits: [{ trait: "archived" }] },
  ],
};

/** Exactly what synthesizeDefaultColumns emits for a v1 graph: every column, NO traits. */
const V1_UPGRADED_IR = {
  version: "v2", id: "wf-v1", name: "legacy", nodes: [], edges: [],
  columns: ["todo", "in-progress", "in-review", "done", "archived"].map((id) => ({ id, name: id, traits: [] })),
};

describe("landedColumnsForTask", () => {
  it("returns the renamed complete AND archived lanes, and not the legacy ids", async () => {
    const landed = await landedColumnsForTask(storeWith(RENAMED_IR), "FN-1");

    expect([...landed].sort()).toEqual(["attic", "shipped"]);
    /*
    The archived half is asserted explicitly: the two roles resolve independently and have failed
    independently before, so a fixture that only proved `complete` would miss half the guard.
    */
    expect(landed.has("done")).toBe(false);
  });

  it("falls back to the legacy pair for a V1-UPGRADED workflow whose columns carry no traits", async () => {
    expect([...(await landedColumnsForTask(storeWith(V1_UPGRADED_IR), "FN-1"))].sort()).toEqual(["archived", "done"]);
  });

  it("falls back to the legacy pair when the workflow cannot be resolved at all", async () => {
    const store = {
      getTaskWorkflowSelectionAsync: async () => { throw new Error("unreadable"); },
      getTaskWorkflowSelection: () => { throw new Error("unreadable"); },
      getWorkflowDefinition: vi.fn(),
    } as never;

    expect([...(await landedColumnsForTask(store, "FN-1"))].sort()).toEqual(["archived", "done"]);
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-30-03:35 (batch-core):
The narrower variant exists so a caller whose contract EXCLUDES archived work does not silently widen
to it. The GitLab backfill reconciler is that caller — its own note records that archived tasks live
in archiveDb and are intentionally excluded. Pinning the difference here is what stops the two being
"simplified" into one helper later, which would change that caller's behaviour without touching it.
*/
describe("completeColumnsForTask is narrower than the landed set", () => {
  it("returns the renamed complete lane and EXCLUDES the archived one", async () => {
    const complete = await completeColumnsForTask(storeWith(RENAMED_IR), "FN-1");

    expect([...complete]).toEqual(["shipped"]);
    expect(complete.has("attic")).toBe(false);
  });

  it("falls back to `done` for a V1-UPGRADED workflow whose complete trait resolves to EMPTY", async () => {
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-08:50 (#2783 review — coderabbit):
    The RESOLVED-BUT-UNEXPRESSED branch, which is a different code path from the `catch` below and was
    the only one of the two left uncovered. `synthesizeDefaultColumns` emits every default column with
    `traits: []`, so the IR resolves fine and `columnsWithFlag(ir, "complete")` returns []. Without
    this case the `length > 0 ? ... : legacy` compatibility branch could regress to returning an empty
    set — refusing every v1 board — while the suite stayed green on the catch path alone.
    */
    expect([...(await completeColumnsForTask(storeWith(V1_UPGRADED_IR), "FN-1"))]).toEqual(["done"]);
  });

  it("falls back to `done` alone, not the legacy pair, when the workflow cannot be resolved", async () => {
    const store = {
      getTaskWorkflowSelectionAsync: async () => { throw new Error("unreadable"); },
      getTaskWorkflowSelection: () => { throw new Error("unreadable"); },
      getWorkflowDefinition: vi.fn(),
    } as never;

    expect([...(await completeColumnsForTask(store, "FN-1"))]).toEqual(["done"]);
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-31-00:05 (self-audit after #2821's review):

THE RESOLVERS NOBODY WAS TESTING.

#2821's review found a bug that lived entirely in a lane BUILDER while every test drove the guard
that consumed it — injecting a value makes the guard testable and the resolver invisible. Auditing
the helpers I added this session for the same shape found three with no direct coverage at all:
`archivedColumnsForTask`, `wipColumnsForTask`, `preWipColumnsForTask`. Their callers are tested; the
functions themselves were not.

They also shared the defect that review named. Each read `resolved.length > 0 ? resolved : legacyId`,
which conflates a v1 upgrade (traits synthesised empty, so the legacy id is the only vocabulary) with
a v2 board that expresses traits and declares no lane of that role — where falling back onto the
legacy id widens the guard onto a role the board deliberately did not assign.

Each helper is now pinned on all four outcomes: the renamed lane, an untraited legacy NAME, the v1
fallback, and the unresolvable fallback.
*/
describe("the lane resolvers themselves, not just their callers", () => {
  const storeFor = (ir: unknown) => {
    const selection = { workflowId: "wf", stepIds: [] as string[] };
    return {
      getTaskWorkflowSelection: () => selection,
      getTaskWorkflowSelectionAsync: async () => selection,
      getWorkflowDefinition: async () => (ir === undefined ? undefined : { id: "wf", ir }),
    } as never;
  };

  /* Traits ARE expressed here, and `done`/`archived`/`in-progress`/`todo` appear WITHOUT them. */
  const TRAITED_WITH_LEGACY_NAMES = {
    version: "v2", id: "wf", name: "wf", nodes: [], edges: [],
    columns: [
      { id: "todo", name: "Not intake", traits: [] },
      { id: "in-progress", name: "Not wip", traits: [] },
      { id: "done", name: "Not complete", traits: [] },
      { id: "archived", name: "Not archived", traits: [] },
      { id: "backlog", name: "Backlog", traits: [{ trait: "hold" }] },
      { id: "building", name: "Building", traits: [{ trait: "wip" }] },
      { id: "attic", name: "Attic", traits: [{ trait: "archived" }] },
    ],
  };

  const V1 = {
    version: "v2", id: "wf", name: "wf", nodes: [], edges: [],
    columns: ["todo", "in-progress", "in-review", "done", "archived"].map((id) => ({ id, name: id, traits: [] })),
  };

  const cases: Array<[string, (s: never, id: string) => Promise<Set<string>>, string, string]> = [
    ["archivedColumnsForTask", archivedColumnsForTask, "attic", "archived"],
    ["wipColumnsForTask", wipColumnsForTask, "building", "in-progress"],
    ["preWipColumnsForTask", preWipColumnsForTask, "backlog", "todo"],
  ];

  for (const [name, resolve, renamed, legacy] of cases) {
    it(`${name} returns the traited lane and EXCLUDES the untraited legacy name`, async () => {
      const lanes = await resolve(storeFor(TRAITED_WITH_LEGACY_NAMES), "FN-1");
      expect(lanes.has(renamed)).toBe(true);
      /* The board declares this column and deliberately did not give it the role. */
      expect(lanes.has(legacy)).toBe(false);
    });

    it(`${name} returns EMPTY when traits are expressed but no column carries this role`, async () => {
      /*
      The case that actually separates the two shapes, and the reason the assertion above could not.
      Where the role IS traited, `resolved.length > 0 ? resolved : legacy` and "trust the resolved
      set" agree — both return the traited lane. They diverge only when the resolved set is EMPTY
      while traits ARE expressed: the old shape falls back onto the legacy NAME, which this board
      declares and deliberately did not give the role; the new one takes the board at its word.

      Caught by mutation: reverting the helper left every other case in this suite green.
      */
      const traitedElsewhere = {
        version: "v2", id: "wf", name: "wf", nodes: [], edges: [],
        columns: [
          { id: "todo", name: "plain", traits: [] },
          { id: "in-progress", name: "plain", traits: [] },
          { id: "done", name: "plain", traits: [] },
          { id: "archived", name: "plain", traits: [] },
          /* One trait, and deliberately never the role under test. */
          { id: "signoff", name: "Signoff", traits: [{ trait: "merge" }] },
        ],
      };
      expect([...(await resolve(storeFor(traitedElsewhere), "FN-1"))]).toEqual([]);
    });

    it(`${name} falls back to the legacy id on a V1-UPGRADED board`, async () => {
      expect([...(await resolve(storeFor(V1), "FN-1"))]).toEqual([legacy]);
    });

    it(`${name} falls back to the legacy id when the workflow cannot be resolved`, async () => {
      expect([...(await resolve(storeFor(undefined), "FN-1"))]).toEqual([legacy]);
    });
  }
});
