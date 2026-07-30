/*
FNXC:WorkflowLifecycleColumns 2026-07-30-12:30 (lifecycle-column census enabler):

`resolveWorkflowIrForTask` returns the default coding IR in two cases that are NOT the same as
knowing which workflow governs a task: the selection read threw, and the store reported no
selection (the synchronous PostgreSQL path does exactly that). Callers cannot tell a guess from a
real answer, and for lifecycle-column work that difference decides correctness.

Concretely: post-merge the default coding lineage declares `todo` as its single Planning column
and NO `triage`. A call site converting a `column === "triage"` guard to trait resolution
therefore stops firing for `builtin:legacy-coding` cards whenever the store cannot name the
workflow — it silently gets the default's vocabulary. Every site converted so far has had to keep
the legacy ids unioned "just in case", which is why the census stalls rather than converging.

These pin the three answers a caller needs to distinguish, and that the existing function's
behaviour is untouched.
*/
import { describe, expect, it, vi } from "vitest";
import { resolveWorkflowIrForTask, resolveWorkflowIrForTaskWithProvenance } from "../workflow-ir-resolver.js";

const WF = "custom:wf";
const customIr = {
  version: "v2",
  id: WF,
  nodes: [],
  edges: [],
  columns: [
    { id: "inbox", label: "Inbox", traits: [{ trait: "intake" }] },
    { id: "building", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
  ],
};

function storeWith(selection: unknown, opts: { throws?: boolean } = {}) {
  return {
    getTaskWorkflowSelectionAsync: async () => {
      if (opts.throws) throw new Error("selection read failed");
      return selection;
    },
    getTaskWorkflowSelection: () => selection,
    getWorkflowDefinition: async (id: string) => (id === WF ? { id: WF, ir: customIr } : undefined),
  } as never;
}

describe("workflow IR resolution provenance", () => {
  it("reports `selection` when the store names a workflow", async () => {
    const resolved = await resolveWorkflowIrForTaskWithProvenance(storeWith({ workflowId: WF, stepIds: [] }), "FN-1");
    expect(resolved.source).toBe("selection");
    expect(resolved.workflowId).toBe(WF);
    expect((resolved.ir as { id: string }).id).toBe(WF);
  });

  it("reports `default` when the store reports NO selection", async () => {
    /* The synchronous PostgreSQL path — a guess that previously looked identical to an answer. */
    const resolved = await resolveWorkflowIrForTaskWithProvenance(storeWith(undefined), "FN-1");
    expect(resolved.source).toBe("default");
    expect(resolved.workflowId).toBeUndefined();
  });

  it("reports `default` when the selection read THROWS", async () => {
    const resolved = await resolveWorkflowIrForTaskWithProvenance(storeWith(undefined, { throws: true }), "FN-1");
    expect(resolved.source).toBe("default");
  });

  it("the default guess really does lack `triage` — which is why provenance matters", async () => {
    /*
    Not a tautology: this is the fact that makes a converted guard stop firing for legacy cards.
    If the default lineage ever regains a `triage` column, the hazard changes and callers relying
    on provenance should be revisited.
    */
    const resolved = await resolveWorkflowIrForTaskWithProvenance(storeWith(undefined), "FN-1");
    const columnIds = ((resolved.ir as { columns?: Array<{ id: string }> }).columns ?? []).map((c) => c.id);
    expect(columnIds).not.toContain("triage");
    expect(columnIds).toContain("todo");
  });

  it("resolveWorkflowIrForTask returns exactly the provenance form's IR (no drift)", async () => {
    for (const store of [storeWith({ workflowId: WF, stepIds: [] }), storeWith(undefined), storeWith(undefined, { throws: true })]) {
      const plain = await resolveWorkflowIrForTask(store, "FN-1");
      const withProvenance = await resolveWorkflowIrForTaskWithProvenance(store, "FN-1");
      expect(plain).toEqual(withProvenance.ir);
    }
  });

  it("shares the caller-owned IR cache — one definition read per workflow", async () => {
    const getWorkflowDefinition = vi.fn(async () => ({ id: WF, ir: customIr }));
    const store = {
      getTaskWorkflowSelectionAsync: async () => ({ workflowId: WF, stepIds: [] }),
      getTaskWorkflowSelection: () => ({ workflowId: WF, stepIds: [] }),
      getWorkflowDefinition,
    } as never;
    const cache = new Map();
    await resolveWorkflowIrForTaskWithProvenance(store, "FN-1", cache);
    await resolveWorkflowIrForTaskWithProvenance(store, "FN-2", cache);
    expect(getWorkflowDefinition).toHaveBeenCalledTimes(1);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-13:25 (PR #2618 review — greptile P1):
`resolveWorkflowIrById` degrades to the default coding IR in three further cases beyond the two
the first version handled — a missing definition, a malformed one, and a throwing lookup. Naming a
selection is not resolving it, and reporting "selection" for any of these hands the caller the
default's columns wearing the selected workflow's label. A provenance signal that lies is worse
than none, because its whole value is that "selection" can be trusted.
*/
describe("a named selection that does not actually resolve is a default", () => {
  const WF = "custom:missing";
  const base = {
    getTaskWorkflowSelectionAsync: async () => ({ workflowId: WF, stepIds: [] }),
    getTaskWorkflowSelection: () => ({ workflowId: WF, stepIds: [] }),
  };

  it("reports `default` when the definition is MISSING", async () => {
    const resolved = await resolveWorkflowIrForTaskWithProvenance(
      { ...base, getWorkflowDefinition: async () => undefined } as never, "FN-1");
    expect(resolved.source).toBe("default");
    expect(resolved.workflowId).toBeUndefined();
  });

  it("reports `default` when the definition lookup THROWS", async () => {
    const resolved = await resolveWorkflowIrForTaskWithProvenance(
      { ...base, getWorkflowDefinition: async () => { throw new Error("db down"); } } as never, "FN-1");
    expect(resolved.source).toBe("default");
  });

  it("reports `default` when the stored definition resolves to a DIFFERENT workflow", async () => {
    /* Identity, not hope: a returned IR whose id is not the selected one is a fallback however
       it arose, so this catches degradation paths added later without touching this test. */
    const resolved = await resolveWorkflowIrForTaskWithProvenance(
      { ...base, getWorkflowDefinition: async () => ({ id: "other", ir: { version: "v2", id: "other", nodes: [], edges: [], columns: [] } }) } as never,
      "FN-1");
    expect(resolved.source).toBe("default");
  });

  it("still reports `selection` when the definition genuinely resolves", async () => {
    const resolved = await resolveWorkflowIrForTaskWithProvenance(
      { ...base, getWorkflowDefinition: async () => ({ id: WF, ir: { version: "v2", id: WF, nodes: [], edges: [], columns: [{ id: "inbox", traits: [{ trait: "intake" }] }] } }) } as never,
      "FN-1");
    expect(resolved.source).toBe("selection");
    expect(resolved.workflowId).toBe(WF);
  });
});
