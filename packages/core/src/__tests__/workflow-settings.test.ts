import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

import {
  validateSettingValuePatch,
  resolveEffectiveSettingValues,
  findOrphanedSettingValues,
  WorkflowSettingRejectionError,
} from "../workflow-settings.js";
import type { WorkflowSettingDefinition, WorkflowIrV2 } from "../workflow-ir-types.js";
import { BUILTIN_WORKFLOW_SETTINGS } from "../builtin-workflow-settings.js";
import { createSharedTaskStoreTestHarness } from "./store-test-helpers.js";

const BUILTIN_CODING = "builtin:coding";
const PROJECT = "proj-1";

/** A minimal valid v2 IR carrying `settings` declarations — enough to round-trip
 *  through `parseWorkflowIr` / `createWorkflowDefinition`. */
function makeIrWithSettings(settings: WorkflowSettingDefinition[]): WorkflowIrV2 {
  return {
    version: "v2",
    name: "Custom WF",
    columns: [],
    nodes: [
      { id: "start", kind: "start" },
      { id: "end", kind: "end" },
    ],
    edges: [{ from: "start", to: "end" }],
    settings,
  };
}

const TIMEOUT_DECL: WorkflowSettingDefinition = {
  id: "workflowStepTimeoutMs",
  name: "Step timeout (ms)",
  type: "number",
  default: 900_000,
};
const FLAG_DECL: WorkflowSettingDefinition = {
  id: "runStepsInNewSessions",
  name: "Run steps in new sessions",
  type: "boolean",
  default: false,
};
const ENUM_DECL: WorkflowSettingDefinition = {
  id: "reviewHandoffPolicy",
  name: "Review handoff policy",
  type: "enum",
  default: "disabled",
  options: [
    { value: "disabled", label: "Disabled" },
    { value: "always", label: "Always" },
  ],
};

// ───────────────────────────────────────────────────────────────────────────
// Validation core (side-effect-free)
// ───────────────────────────────────────────────────────────────────────────

describe("validateSettingValuePatch", () => {
  const decls = [TIMEOUT_DECL, FLAG_DECL, ENUM_DECL];

  it("accepts and normalizes valid values of each type", () => {
    const res = validateSettingValuePatch(decls, {
      workflowStepTimeoutMs: 1000,
      runStepsInNewSessions: true,
      reviewHandoffPolicy: "always",
    });
    expect(res.rejections).toEqual([]);
    expect(res.accepted).toEqual({
      workflowStepTimeoutMs: 1000,
      runStepsInNewSessions: true,
      reviewHandoffPolicy: "always",
    });
  });

  it("accepts null as a delete sentinel (null-as-delete)", () => {
    const res = validateSettingValuePatch(decls, { workflowStepTimeoutMs: null });
    expect(res.rejections).toEqual([]);
    expect(res.accepted).toEqual({ workflowStepTimeoutMs: null });
  });

  it("rejects an unknown setting", () => {
    const res = validateSettingValuePatch(decls, { nope: 1 });
    expect(res.accepted).toEqual({});
    expect(res.rejections).toHaveLength(1);
    expect(res.rejections[0]).toMatchObject({ code: "unknown-setting", settingId: "nope" });
  });

  it("rejects a type mismatch", () => {
    const res = validateSettingValuePatch(decls, { workflowStepTimeoutMs: "fast" });
    expect(res.accepted).toEqual({});
    expect(res.rejections[0]).toMatchObject({ code: "type-mismatch", settingId: "workflowStepTimeoutMs" });
  });

  it("rejects an enum violation", () => {
    const res = validateSettingValuePatch(decls, { reviewHandoffPolicy: "sometimes" });
    expect(res.accepted).toEqual({});
    expect(res.rejections[0]).toMatchObject({ code: "enum-violation", settingId: "reviewHandoffPolicy" });
  });

  it("reports no-settings-defined for a non-null write against empty declarations", () => {
    const res = validateSettingValuePatch([], { workflowStepTimeoutMs: 1 });
    expect(res.accepted).toEqual({});
    expect(res.rejections[0]).toMatchObject({ code: "no-settings-defined" });
  });

  it("accepts a delete even against empty declarations (clears stale rows)", () => {
    const res = validateSettingValuePatch([], { workflowStepTimeoutMs: null });
    expect(res.rejections).toEqual([]);
    expect(res.accepted).toEqual({ workflowStepTimeoutMs: null });
  });

  it("reports every offending key (not fail-fast)", () => {
    const res = validateSettingValuePatch(decls, {
      workflowStepTimeoutMs: "x",
      reviewHandoffPolicy: "x",
    });
    expect(res.rejections).toHaveLength(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Effective resolution (drop-on-orphan, KTD-6)
// ───────────────────────────────────────────────────────────────────────────

describe("resolveEffectiveSettingValues", () => {
  it("uses the stored value when it still validates", () => {
    const eff = resolveEffectiveSettingValues([TIMEOUT_DECL], { workflowStepTimeoutMs: 1000 });
    expect(eff).toEqual({ workflowStepTimeoutMs: 1000 });
  });

  it("falls to the declaration default when unset", () => {
    const eff = resolveEffectiveSettingValues([TIMEOUT_DECL], {});
    expect(eff).toEqual({ workflowStepTimeoutMs: 900_000 });
  });

  it("drops a stored value that no longer validates (enum→number retype) and uses the default", () => {
    // Stored a string under what is now a number declaration.
    const retyped: WorkflowSettingDefinition = { id: "x", name: "X", type: "number", default: 42 };
    const eff = resolveEffectiveSettingValues([retyped], { x: "stale-string" });
    expect(eff).toEqual({ x: 42 });
  });

  it("drops stored values for ids with no current declaration", () => {
    const eff = resolveEffectiveSettingValues([TIMEOUT_DECL], { removedSetting: 7 });
    expect(eff).toEqual({ workflowStepTimeoutMs: 900_000 });
  });

  it("omits a setting with neither a valid value nor a default", () => {
    const noDefault: WorkflowSettingDefinition = { id: "y", name: "Y", type: "number" };
    const eff = resolveEffectiveSettingValues([noDefault], {});
    expect(eff).toEqual({});
  });
});

describe("findOrphanedSettingValues", () => {
  it("surfaces values dropped by resolution (id + raw value) for the editor disclosure", () => {
    const retyped: WorkflowSettingDefinition = { id: "x", name: "X", type: "number", default: 42 };
    const orphans = findOrphanedSettingValues([retyped], { x: "stale-string", removed: 9 });
    expect(orphans).toEqual([
      { id: "x", value: "stale-string" },
      { id: "removed", value: 9 },
    ]);
  });

  it("ignores null/undefined stored entries", () => {
    const orphans = findOrphanedSettingValues([TIMEOUT_DECL], { workflowStepTimeoutMs: null });
    expect(orphans).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Store write authority (U2 scenarios)
// ───────────────────────────────────────────────────────────────────────────

describe("TaskStore.updateWorkflowSettingValues", () => {
  const harness = createSharedTaskStoreTestHarness();

  beforeAll(harness.beforeAll);
  afterAll(harness.afterAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);

  async function createCustomWorkflow(settings: WorkflowSettingDefinition[]): Promise<string> {
    const def = await harness.store().createWorkflowDefinition({
      name: "Custom WF",
      ir: makeIrWithSettings(settings),
    });
    return def.id;
  }

  it("persists a valid value for a custom workflow and reads it back typed", async () => {
    const store = harness.store();
    const wfId = await createCustomWorkflow([TIMEOUT_DECL, FLAG_DECL]);

    await store.updateWorkflowSettingValues(wfId, PROJECT, {
      workflowStepTimeoutMs: 5000,
      runStepsInNewSessions: true,
    });

    const stored = store.getWorkflowSettingValues(wfId, PROJECT);
    expect(stored).toEqual({ workflowStepTimeoutMs: 5000, runStepsInNewSessions: true });
    expect(typeof stored.workflowStepTimeoutMs).toBe("number");
    expect(typeof stored.runStepsInNewSessions).toBe("boolean");
  });

  it("accepts value writes for (builtin:coding, project) while builtin declaration edits stay rejected", async () => {
    const store = harness.store();

    // R4: value write for a built-in workflow succeeds.
    await store.updateWorkflowSettingValues(BUILTIN_CODING, PROJECT, { requirePrApproval: true });
    expect(store.getWorkflowSettingValues(BUILTIN_CODING, PROJECT)).toEqual({ requirePrApproval: true });

    // Built-in DECLARATION edits remain rejected on the separate error path (KTD-2).
    await expect(
      store.updateWorkflowDefinition(BUILTIN_CODING, { ir: makeIrWithSettings([TIMEOUT_DECL]) }),
    ).rejects.toThrow(/Built-in workflows cannot be edited/);
  });

  it("rejects type-mismatch / unknown-setting / enum-violation and persists nothing", async () => {
    const store = harness.store();
    const wfId = await createCustomWorkflow([TIMEOUT_DECL, ENUM_DECL]);

    await expect(
      store.updateWorkflowSettingValues(wfId, PROJECT, { workflowStepTimeoutMs: "fast" }),
    ).rejects.toBeInstanceOf(WorkflowSettingRejectionError);
    await expect(
      store.updateWorkflowSettingValues(wfId, PROJECT, { unknownKey: 1 }),
    ).rejects.toBeInstanceOf(WorkflowSettingRejectionError);
    await expect(
      store.updateWorkflowSettingValues(wfId, PROJECT, { reviewHandoffPolicy: "nope" }),
    ).rejects.toBeInstanceOf(WorkflowSettingRejectionError);

    // Nothing was persisted by any rejected write.
    expect(store.getWorkflowSettingValues(wfId, PROJECT)).toEqual({});
  });

  it("treats null as delete and effective resolution falls to the declaration default", async () => {
    const store = harness.store();
    const wfId = await createCustomWorkflow([TIMEOUT_DECL]);

    await store.updateWorkflowSettingValues(wfId, PROJECT, { workflowStepTimeoutMs: 5000 });
    expect(store.getWorkflowSettingValues(wfId, PROJECT)).toEqual({ workflowStepTimeoutMs: 5000 });

    await store.updateWorkflowSettingValues(wfId, PROJECT, { workflowStepTimeoutMs: null });
    const stored = store.getWorkflowSettingValues(wfId, PROJECT);
    expect(stored).toEqual({});

    const def = await store.getWorkflowDefinition(wfId);
    const decls = def!.ir.version === "v2" ? def!.ir.settings : undefined;
    expect(resolveEffectiveSettingValues(decls, stored)).toEqual({ workflowStepTimeoutMs: 900_000 });
  });

  it("retype enum→number with a stale stored string: effective resolution drops it, returns default, stored row untouched", async () => {
    const store = harness.store();
    // Declare an enum setting and store a valid enum value.
    const wfId = await createCustomWorkflow([ENUM_DECL]);
    await store.updateWorkflowSettingValues(wfId, PROJECT, { reviewHandoffPolicy: "always" });
    expect(store.getWorkflowSettingValues(wfId, PROJECT)).toEqual({ reviewHandoffPolicy: "always" });

    // Retype the same id to a number (declaration edit via the IR save path).
    const retyped: WorkflowSettingDefinition = {
      id: "reviewHandoffPolicy",
      name: "Review handoff policy",
      type: "number",
      default: 99,
    };
    await store.updateWorkflowDefinition(wfId, { ir: makeIrWithSettings([retyped]) });

    // Stored row is UNTOUCHED — the stale string survives in storage.
    const stored = store.getWorkflowSettingValues(wfId, PROJECT);
    expect(stored).toEqual({ reviewHandoffPolicy: "always" });

    // Effective resolution drops the stale string and returns the new default.
    expect(resolveEffectiveSettingValues([retyped], stored)).toEqual({ reviewHandoffPolicy: 99 });
  });

  it("cascade-deletes value rows when the custom workflow is deleted", async () => {
    const store = harness.store();
    const wfId = await createCustomWorkflow([TIMEOUT_DECL]);
    await store.updateWorkflowSettingValues(wfId, PROJECT, { workflowStepTimeoutMs: 5000 });
    await store.updateWorkflowSettingValues(wfId, "proj-2", { workflowStepTimeoutMs: 7000 });

    await store.deleteWorkflowDefinition(wfId);

    expect(store.getWorkflowSettingValues(wfId, PROJECT)).toEqual({});
    expect(store.getWorkflowSettingValues(wfId, "proj-2")).toEqual({});
  });

  it("a task pinned to a deleted workflow resolves built-in values", async () => {
    const store = harness.store();
    // Built-in values for the project (these survive a custom-workflow delete).
    await store.updateWorkflowSettingValues(BUILTIN_CODING, PROJECT, { requirePrApproval: true });

    const wfId = await createCustomWorkflow([TIMEOUT_DECL]);
    await store.updateWorkflowSettingValues(wfId, PROJECT, { workflowStepTimeoutMs: 5000 });
    await store.deleteWorkflowDefinition(wfId);

    // The deleted workflow's rows are gone; a task pinned to it degrades to
    // builtin:coding (resolver) and reads built-in declarations + built-in values.
    expect(store.getWorkflowSettingValues(wfId, PROJECT)).toEqual({});
    const effective = resolveEffectiveSettingValues(
      BUILTIN_WORKFLOW_SETTINGS,
      store.getWorkflowSettingValues(BUILTIN_CODING, PROJECT),
    );
    expect(effective.requirePrApproval).toBe(true);
    // Untouched built-in keys resolve to their declaration defaults.
    expect(effective.workflowStepTimeoutMs).toBe(900_000);
  });
});

describe("TaskStore.getModelLaneDrift", () => {
  const harness = createSharedTaskStoreTestHarness();

  beforeAll(harness.beforeAll);
  afterAll(harness.afterAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);

  it("flags non-terminal tasks still pinned to a lane's old value, and excludes done/unrelated tasks", async () => {
    const store = harness.store();

    await store.updateWorkflowSettingValues(BUILTIN_CODING, PROJECT, {
      executionProvider: "anthropic",
      executionModelId: "claude-sonnet-4-6",
    });
    const before = store.getWorkflowSettingValues(BUILTIN_CODING, PROJECT);

    const pinned = await store.createTask({
      description: "pinned to old model",
      workflowId: BUILTIN_CODING,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    const alreadyCurrent = await store.createTask({
      description: "already on the new model",
      workflowId: BUILTIN_CODING,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-5",
    });
    const doneTask = await store.createTask({
      description: "terminal task, excluded even though pinned to the old model",
      workflowId: BUILTIN_CODING,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-6",
      column: "done",
    });

    await store.updateWorkflowSettingValues(BUILTIN_CODING, PROJECT, {
      executionModelId: "claude-sonnet-5",
    });
    const after = store.getWorkflowSettingValues(BUILTIN_CODING, PROJECT);

    const drift = store.getModelLaneDrift(BUILTIN_CODING, before, after);
    expect(drift).toHaveLength(1);
    const execution = drift[0];
    expect(execution.lane).toBe("execution");
    expect(execution.from).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-6" });
    expect(execution.to).toEqual({ provider: "anthropic", modelId: "claude-sonnet-5" });
    expect(execution.taskIds).toEqual([pinned.id]);
    expect(execution.taskIds).not.toContain(alreadyCurrent.id);
    expect(execution.taskIds).not.toContain(doneTask.id);
  });

  it("reports no drift when the lane value is unchanged", async () => {
    const store = harness.store();
    await store.updateWorkflowSettingValues(BUILTIN_CODING, PROJECT, {
      executionProvider: "anthropic",
      executionModelId: "claude-sonnet-5",
    });
    const before = store.getWorkflowSettingValues(BUILTIN_CODING, PROJECT);
    await store.updateWorkflowSettingValues(BUILTIN_CODING, PROJECT, { requirePrApproval: true });
    const after = store.getWorkflowSettingValues(BUILTIN_CODING, PROJECT);

    expect(store.getModelLaneDrift(BUILTIN_CODING, before, after)).toEqual([]);
  });
});
