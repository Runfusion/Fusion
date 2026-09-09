import { describe, expect, it } from "vitest";

import { validateNodeOverrideChange, resolveNodeOverrideLanes } from "../mesh/node-override-guard.js";

/*
FNXC:WorkflowResolvedColumns 2026-07-30-22:35 (batch-core):

BOTH GUARDS ANSWERED A ROLE QUESTION WITH A COLUMN NAME.

  - "is this task executing right now?" refused a mid-flight override. Keyed on `in-progress`, a
    renamed board let an operator re-route a RUNNING task — precisely what the guard exists to stop.
  - the terminal-node gate asks whether the task has COMPLETED. Keyed on `done`, a renamed board
    refused the override for exactly the tasks that had legitimately reached the end node.

The guard is synchronous by design, so the lanes are injected — and both production callers
(`branch-and-pr-entities.ts` and `task-update.ts`) now resolve and pass them, which is what keeps
this from being an option only tests supply.
*/
/*
FNXC:WorkflowResolvedColumns 2026-07-30-23:30 (#2821 review — greptile):

THE RESOLVER'S OWN CONTRACT, which the guard-level cases above cannot reach.

Those pass the sets in by hand, so they pin what `validateNodeOverrideChange` does with a set and say
nothing about how the set is BUILT. The floor bug lived in the builder: seeding the legacy ids and
adding resolved lanes on top meant a v2 board that declares `in-progress` as an ordinary untraited
column still had it counted as WIP. Mutating the resolver back to a floor left every guard-level case
green — which is exactly why this suite needs a resolver-level one.
*/
describe("resolveNodeOverrideLanes builds the set from traits, with legacy as an ELSE", () => {
  const storeFor = (ir: unknown) => {
    const selection = { workflowId: "wf", stepIds: [] as string[] };
    return {
      getTaskWorkflowSelection: () => selection,
      getTaskWorkflowSelectionAsync: async () => selection,
      getWorkflowDefinition: async () => (ir === undefined ? undefined : { id: "wf", ir }),
    } as never;
  };

  it("EXCLUDES a legacy-named column the board declares without the trait", async () => {
    const ir = {
      version: "v2", id: "wf", name: "wf", nodes: [], edges: [],
      columns: [
        { id: "in-progress", name: "Not actually wip", traits: [] },
        { id: "building", name: "Building", traits: [{ trait: "wip" }] },
        { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
      ],
    };
    const lanes = await resolveNodeOverrideLanes(storeFor(ir), "FN-1");

    expect([...lanes.wipColumns]).toEqual(["building"]);
    expect(lanes.wipColumns.has("in-progress")).toBe(false);
    expect([...lanes.completeColumns]).toEqual(["shipped"]);
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-01:35:
  EVERY wip lane, not the first — the case that separates this resolver from `resolveLifecycleColumns`.

  A board may carry the wip trait on more than one column (a build lane beside a verify lane). This
  resolver answers with all of them (`columnsWithFlag`); `resolveLifecycleColumns` answers with the
  FIRST (`resolved.find(...)`, workflow-lifecycle-traits.ts:353). The two are interchangeable on every
  single-wip-lane board, so substituting one for the other reads as correct and is not.

  It is not hypothetical: #3019 wired the CLI's `fn_task_update` guard with the first-match resolver,
  and a task sitting in the SECOND wip lane went on slipping the mid-flight check the PR set out to
  close. A single-wip-lane test passes against both, which is why this case names two.
  */
  it("returns EVERY wip lane, not just the first", async () => {
    const ir = {
      version: "v2", id: "wf", name: "wf", nodes: [], edges: [],
      columns: [
        { id: "building", name: "Building", traits: [{ trait: "wip" }] },
        { id: "verifying", name: "Verifying", traits: [{ trait: "wip" }] },
        { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
      ],
    };
    const lanes = await resolveNodeOverrideLanes(storeFor(ir), "FN-1");

    expect([...lanes.wipColumns].sort()).toEqual(["building", "verifying"]);
    /* The load-bearing half: a task in the second lane must still be seen as executing. */
    expect(lanes.wipColumns.has("verifying")).toBe(true);
  });

  it("falls back to the legacy ids for a V1-UPGRADED board that traits nothing", async () => {
    const v1 = {
      version: "v2", id: "wf", name: "wf", nodes: [], edges: [],
      columns: ["todo", "in-progress", "done"].map((id) => ({ id, name: id, traits: [] })),
    };
    const lanes = await resolveNodeOverrideLanes(storeFor(v1), "FN-1");

    expect([...lanes.wipColumns]).toEqual(["in-progress"]);
    expect([...lanes.completeColumns]).toEqual(["done"]);
  });

  it("falls back to the legacy ids when the workflow cannot be resolved", async () => {
    const lanes = await resolveNodeOverrideLanes(storeFor(undefined), "FN-1");
    expect([...lanes.wipColumns]).toEqual(["in-progress"]);
    expect([...lanes.completeColumns]).toEqual(["done"]);
  });
});

describe("node override lanes are resolved, not named", () => {
  const RENAMED = { wipColumns: new Set(["building"]), completeColumns: new Set(["shipped"]) };

  it("refuses a mid-flight override for a task in a RENAMED wip lane", () => {
    const result = validateNodeOverrideChange(
      { id: "FN-1", column: "building" } as never, "some-node", RENAMED,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("task-in-progress");
  });

  it("still ALLOWS an override for a task outside every wip lane", () => {
    /* The paired negative: resolving lanes must not turn the guard into a blanket refusal. */
    const result = validateNodeOverrideChange(
      { id: "FN-2", column: "backlog" } as never, "some-node", RENAMED,
    );
    expect(result.allowed).toBe(true);
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-23:10 (#2821 review — greptile):
  A LEGACY NAME THE BOARD DOES NOT TRAIT IS NOT THAT ROLE.

  The first version SEEDED the legacy ids and added the resolved lanes on top, so a v2 board that
  declares `in-progress` as an ordinary untraited column still had it treated as WIP — blocking a
  mid-flight override that the board's own traits say is fine. The fallback has to be an ELSE, not a
  floor.

  This drives the resolved sets directly (the guard is synchronous and takes them), so it pins the
  contract the resolver must honour.
  */
  it("ALLOWS an override for a legacy-named column the board does not trait as wip", () => {
    const result = validateNodeOverrideChange(
      { id: "FN-4", column: "in-progress" } as never,
      "some-node",
      { wipColumns: new Set(["building"]), completeColumns: new Set(["shipped"]) },
    );
    expect(result.allowed).toBe(true);
  });

  it("permits a terminal-node override for a task finished in a RENAMED complete lane", () => {
    const result = validateNodeOverrideChange(
      { id: "FN-3", column: "shipped" } as never, "end", RENAMED,
    );
    expect(result.allowed).toBe(true);
  });
});

describe("validateNodeOverrideChange", () => {
  it("allows when newNodeId is undefined (not being changed)", () => {
    const result = validateNodeOverrideChange(
      { id: "FN-1", column: "in-progress", nodeId: "node-a" },
      undefined,
    );
    expect(result).toEqual({ allowed: true });
  });

  it.each(["triage", "todo", "in-review", "done"])(
    "allows setting nodeId on a task in %s",
    (column) => {
      const result = validateNodeOverrideChange({ id: "FN-1", column }, "node-b");
      expect(result).toEqual({ allowed: true });
    },
  );

  it("allows clearing nodeId (null) on a task in todo", () => {
    const result = validateNodeOverrideChange(
      { id: "FN-1", column: "todo", nodeId: "node-a" },
      null,
    );
    expect(result).toEqual({ allowed: true });
  });

  it("allows changing nodeId from one value to another in todo", () => {
    const result = validateNodeOverrideChange(
      { id: "FN-1", column: "todo", nodeId: "node-a" },
      "node-b",
    );
    expect(result).toEqual({ allowed: true });
  });

  it.each(["node-a", null, "same-node"])(
    "blocks nodeId updates on an in-progress task for value %p",
    (newNodeId) => {
      const result = validateNodeOverrideChange(
        { id: "FN-999", column: "in-progress", nodeId: "same-node" },
        newNodeId,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("task-in-progress");
      expect(result.message).toContain("FN-999");
      expect(result.message?.toLowerCase()).toContain("in progress");
      expect(result.message).toContain("pause/stop");
    },
  );

  it("returns exact task-in-progress reason and actionable guidance in message", () => {
    const result = validateNodeOverrideChange(
      { id: "FN-999", column: "in-progress", nodeId: "node-a" },
      "node-b",
    );

    expect(result).toMatchObject({
      allowed: false,
      reason: "task-in-progress",
    });
    expect(result.message).toContain("FN-999");
    expect(result.message?.toLowerCase()).toContain("wait");
    expect(result.message?.toLowerCase()).toContain("pause");
    expect(result.message?.toLowerCase()).toContain("stop");
  });

  it("blocks setting nodeId on in-progress task even when existing nodeId is undefined", () => {
    const result = validateNodeOverrideChange({ id: "FN-404", column: "in-progress" }, "node-new");

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("task-in-progress");
    expect(result.message).toContain("FN-404");
  });

  it("allows nodeId change on in-progress task when newNodeId is undefined (no-op)", () => {
    const result = validateNodeOverrideChange(
      { id: "FN-2", column: "in-progress", nodeId: "node-a" },
      undefined,
    );
    expect(result).toEqual({ allowed: true });
  });

  it("blocks setting nodeId to same value on in-progress when passed as explicit string", () => {
    const result = validateNodeOverrideChange(
      { id: "FN-2", column: "in-progress", nodeId: "node-a" },
      "node-a",
    );
    expect(result.allowed).toBe(false);
  });

  // FNXC:StateMachine 2026-07-07-12:00: Signature 2 (FN-7641 / NEXT-322 / NEXT-375 / NEXT-340)
  // regression — nodeId='end' must finalize-on-proof or return an explicit error, never a
  // silent no-op. Covers in-review with/without merge proof, non-terminal overrides unchanged,
  // clearing the override unchanged, and the still-enforced in-progress guard.
  describe("terminal 'end' node override (FN-7641 Signature 2)", () => {
    it("REPRO: signals requiresFinalize instead of a silent allow for in-review + merge proof", () => {
      const result = validateNodeOverrideChange(
        { id: "FN-322", column: "in-review", mergeDetails: { mergeConfirmed: true } },
        "end",
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresFinalize).toBe(true);
    });

    it("REPRO: rejects nodeId='end' with an explicit error when there is NO merge proof (never silent)", () => {
      const result = validateNodeOverrideChange(
        { id: "FN-322", column: "in-review" },
        "end",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("terminal-without-merge-proof");
      expect(result.message).toContain("FN-322");
      expect(result.message).toContain("nodeId='end'");
      expect(result.message?.toLowerCase()).toContain("merge");
    });

    it("rejects nodeId='end' with explicit error when mergeConfirmed is explicitly false", () => {
      const result = validateNodeOverrideChange(
        { id: "FN-375", column: "in-review", mergeDetails: { mergeConfirmed: false } },
        "end",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("terminal-without-merge-proof");
    });

    it("allows nodeId='end' as a no-op when the task is already done, even without merge proof", () => {
      const result = validateNodeOverrideChange({ id: "FN-340", column: "done" }, "end");
      expect(result).toEqual({ allowed: true });
    });

    it("does not gate non-terminal nodeId overrides even with no merge proof", () => {
      const result = validateNodeOverrideChange(
        { id: "FN-1", column: "in-review" },
        "plan-review",
      );
      expect(result).toEqual({ allowed: true });
    });

    it("does not gate clearing the override (null) even on a terminal-eligible task with no proof", () => {
      const result = validateNodeOverrideChange(
        { id: "FN-1", column: "in-review", nodeId: "end" },
        null,
      );
      expect(result).toEqual({ allowed: true });
    });

    it("still blocks in-progress tasks before the terminal-node check runs", () => {
      const result = validateNodeOverrideChange(
        { id: "FN-1", column: "in-progress", mergeDetails: { mergeConfirmed: true } },
        "end",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("task-in-progress");
    });

    it("uses a caller-supplied isTerminalNodeId resolver instead of the literal 'end' fallback", () => {
      const isTerminalNodeId = (nodeId: string) => nodeId === "custom-terminal";

      const noProof = validateNodeOverrideChange(
        { id: "FN-1", column: "in-review" },
        "custom-terminal",
        { isTerminalNodeId },
      );
      expect(noProof.allowed).toBe(false);
      expect(noProof.reason).toBe("terminal-without-merge-proof");

      const literalEndNotTerminalHere = validateNodeOverrideChange(
        { id: "FN-1", column: "in-review" },
        "end",
        { isTerminalNodeId },
      );
      expect(literalEndNotTerminalHere).toEqual({ allowed: true });
    });

    it("todo/in-progress non-terminal cards with merge proof are unaffected by the terminal gate", () => {
      const result = validateNodeOverrideChange(
        { id: "FN-1", column: "todo", mergeDetails: { mergeConfirmed: true } },
        "execute",
      );
      expect(result).toEqual({ allowed: true });
    });
  });
});
