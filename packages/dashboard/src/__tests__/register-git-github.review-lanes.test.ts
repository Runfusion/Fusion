// @vitest-environment node

/*
FNXC:WorkflowResolvedColumns 2026-07-30-23:10 (batch-core):

THE REVIEW-LANE DECISION BEHIND THE PR ROUTES.

`register-git-github.ts` gated three PR routes (create / push-branch / resolve-conflicts) and the
CHANGES_REQUESTED handler on `task.column !== "in-review"`. On a renamed board none matched, so every
PR affordance the dashboard offers was refused for a card sitting in the lane the board itself calls
review — and the refusal named a column that does not exist there. All four now share
`reviewColumnsForTask`, and this pins what that helper answers.

WHY THE SEAM AND NOT THE ROUTES. I wrote the route-level version first and deleted it: an HTTP
fixture over `registerGitGitHubRoutes` hangs — every case, including the pure refusals, times out at
4s because registering the router starts background work the fixture never satisfies. Making it run
would mean mocking git, the GitHub client, and the pollers: a mock-the-world shell, which is exactly
what the project's "do not add slow tests" rule (FN-5048) says to avoid in favour of a narrow seam.
The helper IS the narrow seam — it holds the entire decision, and the four call sites now do nothing
but ask it and render its answer.

TWO CASES THAT PULL IN OPPOSITE DIRECTIONS, which is the whole reason this is subtle:

  renamed v2 — the board declares `signoff`; the helper must return it and NOT `in-review`.
  upgraded v1 — `synthesizeDefaultColumns` (workflow-ir.ts:158-159) emits every default column with
                `traits: []`, so the resolved set is EMPTY even though `in-review` exists and holds
                the card. Treating empty as "no review lane" refuses every pre-v2 project. Empty
                means UNEXPRESSED, so it falls back to the legacy id.

A fixture covering only the renamed case would pass an implementation that breaks every v1 board —
the more damaging failure, and the one no v2 test can see.

This is the dashboard twin of `fn pr create`'s guard (packages/cli/src/commands/pr.ts); the two
surfaces answer the same question and must agree (FN-5893 surface enumeration).
*/
import { describe, expect, it, vi } from "vitest";
import "@fusion/core"; // registers the built-in column traits, so `human-review` resolves its flags
import { reviewColumnsForTask, namedReviewColumns } from "../routes/register-git-github.js";

/** Renamed v2 board: `signoff` carries the merge trait, and there is no `in-review` column at all. */
const RENAMED_IR = {
  version: "v2",
  id: "wf-renamed",
  name: "renamed",
  nodes: [],
  edges: [],
  columns: [
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "signoff", name: "Signoff", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
};

/** A board with a merge lane AND a separate human sign-off lane — both are review lanes. */
const TWO_LANE_IR = {
  version: "v2",
  id: "wf-two",
  name: "two-lane",
  nodes: [],
  edges: [],
  columns: [
    { id: "signoff", name: "Signoff", traits: [{ trait: "merge" }] },
    { id: "approval", name: "Approval", traits: [{ trait: "human-review" }] },
  ],
};

/** Exactly what synthesizeDefaultColumns emits for a v1 graph: every column, NO traits. */
const V1_UPGRADED_IR = {
  version: "v2",
  id: "wf-v1",
  name: "legacy",
  nodes: [],
  edges: [],
  columns: ["todo", "in-progress", "in-review", "done", "archived"].map((id) => ({ id, name: id, traits: [] })),
};

function storeWith(ir: unknown, workflowId = "wf") {
  const selection = { workflowId, stepIds: [] as string[] };
  return {
    getTaskWorkflowSelection: () => selection,
    getTaskWorkflowSelectionAsync: async () => selection,
    getWorkflowDefinition: async () => (ir === undefined ? undefined : { id: workflowId, ir }),
  } as never;
}

describe("reviewColumnsForTask resolves the review lane from the task's own workflow", () => {
  it("returns the RENAMED review lane, and not the legacy id", async () => {
    const columns = await reviewColumnsForTask(storeWith(RENAMED_IR), "FN-1");

    expect([...columns]).toEqual(["signoff"]);
    /*
    The absence matters as much as the presence: while `in-review` is in the set, the refusal message
    names a column this board does not declare, which is the operator-visible half of the bug.
    */
    expect(columns.has("in-review")).toBe(false);
  });

  it("returns BOTH lanes when a board declares a merge lane and a separate human-review lane", async () => {
    /*
    Membership, not a single id. `resolveLifecycleColumns` returns the FIRST column per trait, so a
    single-id answer silently ignores the second lane and refuses PRs from it. This is the arity trap
    that has recurred throughout this program.
    */
    const columns = await reviewColumnsForTask(storeWith(TWO_LANE_IR), "FN-1");

    expect([...columns].sort()).toEqual(["approval", "signoff"]);
  });

  it("falls back to the legacy id for a V1-UPGRADED workflow whose columns carry no traits", async () => {
    const columns = await reviewColumnsForTask(storeWith(V1_UPGRADED_IR), "FN-1");

    expect([...columns]).toEqual(["in-review"]);
  });

  it("falls back to the legacy id when the workflow cannot be resolved at all", async () => {
    /*
    "Could not read" is a different question from "read, and there is no review lane" — but on this
    guard both take the legacy answer, because the v1 upgrade path makes an empty set indistinguishable
    from an unexpressed one. Pinned so the two branches cannot drift apart.
    */
    const store = {
      getTaskWorkflowSelectionAsync: async () => { throw new Error("no selection"); },
      getTaskWorkflowSelection: () => { throw new Error("no selection"); },
      getWorkflowDefinition: vi.fn(),
    } as never;

    expect([...(await reviewColumnsForTask(store, "FN-1"))]).toEqual(["in-review"]);
  });
});

describe("namedReviewColumns renders a refusal an operator can act on", () => {
  it("quotes a single lane", () => {
    expect(namedReviewColumns(new Set(["signoff"]))).toBe("'signoff'");
  });

  it("joins multiple lanes with 'or', so the operator sees every lane that would work", () => {
    expect(namedReviewColumns(new Set(["signoff", "approval"]))).toBe("'signoff' or 'approval'");
  });
});
