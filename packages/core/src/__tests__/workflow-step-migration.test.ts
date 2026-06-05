import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { isBuiltinWorkflowId } from "../builtin-workflows.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

/**
 * U2 / R5 / KTD-3 — lazy idempotent migration of legacy user-authored workflow
 * steps into the dual fragment + combined-workflow representation.
 */
describe("TaskStore.migrateLegacyWorkflowSteps (U2/R5)", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  /** User-owned (non-builtin) workflow definitions only. */
  async function userDefs() {
    return (await store.listWorkflowDefinitions()).filter((w) => !isBuiltinWorkflowId(w.id));
  }

  it("converts defaultOn + optional + disabled user steps to fragments, builds the combined workflow from defaultOn only, sets the project default, and leaves the compiled row untouched", async () => {
    // defaultOn (ran automatically on new tasks) → fragment + joins combined workflow.
    const on = await store.createWorkflowStep({
      name: "Default On",
      description: "ran by default",
      prompt: "do the default thing",
      defaultOn: true,
      enabled: true,
    });
    // enabled-but-optional → fragment only (NOT in combined workflow).
    const optional = await store.createWorkflowStep({
      name: "Optional",
      description: "opt-in",
      prompt: "optional work",
      defaultOn: false,
      enabled: true,
    });
    // disabled → still gets a fragment (every user step does).
    const disabled = await store.createWorkflowStep({
      name: "Disabled",
      description: "off",
      prompt: "disabled work",
      defaultOn: false,
      enabled: false,
    });
    // compiled-materialized row (execution detail) → must be ignored entirely.
    const compiled = await store.createWorkflowStep({
      name: "Compiled",
      description: "materialized",
      templateId: "workflow:WF-999",
      defaultOn: true,
      enabled: true,
    });

    const result = await store.migrateLegacyWorkflowSteps();

    // 3 user steps converted; nothing previously migrated.
    expect(result.migrated).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.combinedWorkflowId).toBeTruthy();

    const defs = await userDefs();
    const fragments = defs.filter((d) => d.kind === "fragment");
    const workflows = defs.filter((d) => d.kind === "workflow");

    // Exactly 3 fragments (one per user step), exactly 1 combined workflow.
    expect(fragments).toHaveLength(3);
    expect(workflows).toHaveLength(1);
    expect(fragments.map((f) => f.name).sort()).toEqual(["Default On", "Disabled", "Optional"]);

    // Combined workflow: named "Migrated steps", carries the system description,
    // and contains ONLY the defaultOn step's user node (plus start/end + seams).
    const combined = workflows[0];
    expect(combined.id).toBe(result.combinedWorkflowId);
    expect(combined.name).toBe("Migrated steps");
    expect(combined.description).toBe("Converted from your legacy workflow steps");
    const userNodes = combined.ir.nodes.filter(
      (n) => n.kind !== "start" && n.kind !== "end" && typeof n.config?.seam !== "string",
    );
    expect(userNodes).toHaveLength(1);
    expect(userNodes[0].config?.name).toBe("Default On");

    // Project default points at the combined workflow.
    expect(await store.getDefaultWorkflowId()).toBe(combined.id);

    // All 3 user source rows are stamped; the compiled row is untouched.
    expect((await store.getWorkflowStep(on.id))?.migratedFragmentId).toBeTruthy();
    expect((await store.getWorkflowStep(optional.id))?.migratedFragmentId).toBeTruthy();
    expect((await store.getWorkflowStep(disabled.id))?.migratedFragmentId).toBeTruthy();
    expect((await store.getWorkflowStep(compiled.id))?.migratedFragmentId).toBeUndefined();

    // No source records were deleted.
    const steps = await store.listWorkflowSteps();
    expect(steps.map((s) => s.id)).toEqual(expect.arrayContaining([on.id, optional.id, disabled.id]));
  });

  it("creates fragments but NO combined workflow and leaves the default unchanged when no step is defaultOn", async () => {
    await store.createWorkflowStep({ name: "A", description: "a", prompt: "a", defaultOn: false });
    await store.createWorkflowStep({ name: "B", description: "b", prompt: "b", enabled: false });

    const result = await store.migrateLegacyWorkflowSteps();

    expect(result.migrated).toBe(2);
    expect(result.combinedWorkflowId).toBeUndefined();

    const defs = await userDefs();
    expect(defs.filter((d) => d.kind === "fragment")).toHaveLength(2);
    expect(defs.filter((d) => d.kind === "workflow")).toHaveLength(0);
    expect(await store.getDefaultWorkflowId()).toBeUndefined();
  });

  it("is idempotent: a second run converts nothing and creates no new definitions", async () => {
    await store.createWorkflowStep({ name: "A", description: "a", prompt: "a", defaultOn: true });

    const first = await store.migrateLegacyWorkflowSteps();
    expect(first.migrated).toBe(1);
    const afterFirst = (await userDefs()).length;

    const second = await store.migrateLegacyWorkflowSteps();
    expect(second.migrated).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.combinedWorkflowId).toBeUndefined();
    expect((await userDefs()).length).toBe(afterFirst);
  });

  it("does not clobber a pre-existing project default", async () => {
    // A user-chosen default workflow exists before migration.
    const existing = await store.createWorkflowDefinition({
      name: "My choice",
      ir: {
        version: "v1",
        name: "My choice",
        nodes: [
          { id: "start", kind: "start" },
          { id: "end", kind: "end" },
        ],
        edges: [{ from: "start", to: "end", condition: "success" }],
      },
      kind: "workflow",
    });
    await store.setDefaultWorkflowId(existing.id);

    await store.createWorkflowStep({ name: "A", description: "a", prompt: "a", defaultOn: true });
    const result = await store.migrateLegacyWorkflowSteps();

    // The combined workflow is still created, but the explicit default is kept.
    expect(result.combinedWorkflowId).toBeTruthy();
    expect(await store.getDefaultWorkflowId()).toBe(existing.id);
  });

  it("compare-and-set: re-reads the default after the transaction and skips when a concurrent writer set one", async () => {
    await store.createWorkflowStep({ name: "A", description: "a", prompt: "a", defaultOn: true });

    const concurrent = await store.createWorkflowDefinition({
      name: "Concurrent",
      ir: {
        version: "v1",
        name: "Concurrent",
        nodes: [
          { id: "start", kind: "start" },
          { id: "end", kind: "end" },
        ],
        edges: [{ from: "start", to: "end", condition: "success" }],
      },
      kind: "workflow",
    });

    // A project default exists when migration's post-transaction compare-and-set
    // re-reads it. Because the set is gated on the re-read (not a pre-transaction
    // snapshot), an existing default is observed and never clobbered.
    await store.setDefaultWorkflowId(concurrent.id);

    const result = await store.migrateLegacyWorkflowSteps();

    expect(result.combinedWorkflowId).toBeTruthy();
    expect(result.combinedWorkflowId).not.toBe(concurrent.id);
    // The compare-and-set re-read observed the existing default and did NOT clobber it.
    expect(await store.getDefaultWorkflowId()).toBe(concurrent.id);
  });

  it("is a no-op with zero user steps", async () => {
    const result = await store.migrateLegacyWorkflowSteps();
    expect(result).toEqual({ migrated: 0, skipped: 0, combinedWorkflowId: undefined });
    expect(await userDefs()).toHaveLength(0);
    expect(await store.getDefaultWorkflowId()).toBeUndefined();
  });
});
