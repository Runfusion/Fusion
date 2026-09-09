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
import { resolveWorkflowIrForTask, resolveWorkflowIrForTaskWithProvenance } from "../workflows/workflow-ir-resolver.js";
import { BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR } from "../workflows/builtin-coding-ideas-v2-workflow-ir.js";

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

  it("resolves a retired built-in through the successor configuration namespace", async () => {
    const getWorkflowPromptOverridesAsync = vi.fn(async () => ({}));
    const resolved = await resolveWorkflowIrForTaskWithProvenance({
      getTaskWorkflowSelectionAsync: async () => ({ workflowId: "builtin:coding-ideas", stepIds: [] }),
      getTaskWorkflowSelection: () => ({ workflowId: "builtin:coding-ideas", stepIds: [] }),
      getWorkflowDefinition: async () => undefined,
      getWorkflowSettingsProjectId: () => "project-successor",
      getWorkflowPromptOverridesAsync,
    } as never, "FN-retired");

    expect(resolved.source).toBe("selection");
    expect(resolved.ir).toEqual(BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR);
    expect(getWorkflowPromptOverridesAsync).toHaveBeenCalledWith("builtin:coding-ideas-v2", "project-successor");
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

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:15 (#2815 review — greptile):
  THE FOURTH DEGRADATION PATH — a BUILT-IN id that is not registered.

  The three cases around this one all go through `store.getWorkflowDefinition`. A workflow id that
  LOOKS built-in never does: `resolveWorkflowIrById` takes the `isBuiltinWorkflowId` branch, calls
  `getBuiltinWorkflow`, and on a miss silently returns the default coding IR. That miss was the one
  path that never got the fallback brand, so provenance reported `selection` for an IR that is a
  guess — and a caller gated on that signal trusts default lanes as the board's own.

  Reachable in production: a plugin-registered workflow whose plugin is no longer loaded, or an id
  recorded by a newer build than the one reading it.
  */
  it("reports `default` when the selection names an UNREGISTERED built-in id", async () => {
    const resolved = await resolveWorkflowIrForTaskWithProvenance(
      {
        getTaskWorkflowSelectionAsync: async () => ({ workflowId: "builtin:no-such-workflow", stepIds: [] }),
        getTaskWorkflowSelection: () => ({ workflowId: "builtin:no-such-workflow", stepIds: [] }),
        getWorkflowDefinition: async () => undefined,
      } as never,
      "FN-1",
    );

    expect(resolved.source).toBe("default");
    /* And it must not name a workflow it did not actually resolve. */
    expect(resolved.workflowId).toBeUndefined();
  });

  it("reports `default` when the definition lookup THROWS", async () => {
    const resolved = await resolveWorkflowIrForTaskWithProvenance(
      { ...base, getWorkflowDefinition: async () => { throw new Error("db down"); } } as never, "FN-1");
    expect(resolved.source).toBe("default");
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:50 (#2815 review — the brand must not leak between tasks):

  A FALLBACK FOR ONE TASK MUST NOT MARK EVERY LATER RESOLUTION.

  `resolveDefaultWorkflowIr()` returns a SHARED object, so branding it in place marked the singleton
  itself: after any task anywhere hit a fallback, every subsequent resolution of `builtin:coding`
  reported `default` — including a task that genuinely selected the default workflow. Process-wide,
  permanent, and invisible, because the brand is non-enumerable and survives no dump or deep-equal.

  It also made the unregistered-builtin case above unfalsifiable: the object under assertion had
  already been branded by an earlier case in this file, so the mark could be deleted with the suite
  still green. Ordering matters here — the fallback runs FIRST, deliberately.
  */
  it("does not leak the fallback brand onto a later legitimate default selection", async () => {
    const selecting = (workflowId: string) => ({
      getTaskWorkflowSelectionAsync: async () => ({ workflowId, stepIds: [] }),
      getTaskWorkflowSelection: () => ({ workflowId, stepIds: [] }),
      getWorkflowDefinition: async () => undefined,
    });

    const fellBack = await resolveWorkflowIrForTaskWithProvenance(selecting("custom:missing") as never, "FN-1");
    expect(fellBack.source).toBe("default");

    /* `builtin:coding` resolves for real, so it is a selection — not collateral from the line above. */
    const legitimate = await resolveWorkflowIrForTaskWithProvenance(selecting("builtin:coding") as never, "FN-2");
    expect(legitimate.source).toBe("selection");
    expect(legitimate.workflowId).toBe("builtin:coding");
  });

  it("reports `selection` when the stored IR carries an id different from the selection", async () => {
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-21:30 (#2815 review — repointed at the shipped contract):

    This asserted `default`, against the id cross-check this PR DELETES, and it was left red by that
    deletion. The expectation is now inverted because the check was wrong in the direction that
    matters: `createWorkflowDefinition` stores an authored IR VERBATIM, so `ir.id` keeps whatever the
    author wrote while the store allocates its own `WF-NNN`. Those two are unequal for EVERY such
    workflow, so the check reported a guess for every custom board — denying trust to exactly the
    boards the provenance API exists to serve.

    Provenance now comes from the resolver's own fallback brand, not from comparing ids after the
    fact, so a genuinely-resolved definition is a selection regardless of what its IR calls itself.
    */
    const resolved = await resolveWorkflowIrForTaskWithProvenance(
      { ...base, getWorkflowDefinition: async () => ({ id: "other", ir: { version: "v2", id: "other", nodes: [], edges: [], columns: [{ id: "inbox", traits: [{ trait: "intake" }] }] } }) } as never,
      "FN-1");
    expect(resolved.source).toBe("selection");
    expect(resolved.workflowId).toBe(WF);
  });

  it("still reports `selection` when the definition genuinely resolves", async () => {
    const resolved = await resolveWorkflowIrForTaskWithProvenance(
      { ...base, getWorkflowDefinition: async () => ({ id: WF, ir: { version: "v2", id: WF, nodes: [], edges: [], columns: [{ id: "inbox", traits: [{ trait: "intake" }] }] } }) } as never,
      "FN-1");
    expect(resolved.source).toBe("selection");
    expect(resolved.workflowId).toBe(WF);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-16:25 (PR #2618 review — greptile P1, 2nd):
An ABSENT IR id is no evidence of a fallback. Requiring a match also denied trust to valid
selections whose IR carries no id — a v1, or a stored v2 that omits it — so the conversion those
callers were promised would quietly not take effect. Only a PRESENT, DIFFERING id proves a
fallback, and that still catches all three degradation paths because each returns the default
coding IR under a different id than the one requested.
*/
describe("an absent IR id is not evidence of a fallback", () => {
  const WF = "custom:no-id";
  const base = {
    getTaskWorkflowSelectionAsync: async () => ({ workflowId: WF, stepIds: [] }),
    getTaskWorkflowSelection: () => ({ workflowId: WF, stepIds: [] }),
  };

  it("reports `selection` for a valid v2 IR that carries no id", async () => {
    const resolved = await resolveWorkflowIrForTaskWithProvenance(
      { ...base, getWorkflowDefinition: async () => ({ id: WF, ir: { version: "v2", nodes: [], edges: [], columns: [{ id: "inbox", traits: [{ trait: "intake" }] }] } }) } as never,
      "FN-1");
    expect(resolved.source).toBe("selection");
    expect(resolved.workflowId).toBe(WF);
  });

  it("still reports `default` when the definition is missing (differing id is the proof)", async () => {
    const resolved = await resolveWorkflowIrForTaskWithProvenance(
      { ...base, getWorkflowDefinition: async () => undefined } as never, "FN-1");
    expect(resolved.source).toBe("default");
  });
});
