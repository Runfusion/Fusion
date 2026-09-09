import { describe, expect, it, vi } from "vitest";

const { readTaskRow } = vi.hoisted(() => ({
  readTaskRow: vi.fn(async () => undefined),
}));

vi.mock("../task-store/async/async-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../task-store/async/async-persistence.js")>()),
  readTaskRow,
}));

import type { TaskStore } from "../store.js";
import {
  getTaskWorkflowSelectionAsyncImpl,
  getTaskWorkflowSelectionsAsyncImpl,
  getWorkflowDefinitionImpl,
  materializeExplicitWorkflowStepsImpl,
  selectTaskWorkflowAndReconcileImpl,
} from "../task-store/workflow-definitions.js";
import { selectTaskWorkflowImpl, setDefaultWorkflowIdImpl } from "../task-store/workflow-ops.js";
import {
  countActiveInCapacitySlotAsyncImpl,
  countActiveInCapacitySlotSyncImpl,
} from "../task-store/project-store-ops.js";
import { getBuiltinWorkflow } from "../workflows/builtin-workflows.js";
import { resolveCapacityPoolId } from "../workflows/workflow-capacity.js";
import type { WorkflowDefinition } from "../workflows/workflow-definition-types.js";

const RETIRED_ID = "builtin:coding-ideas";
const SUCCESSOR_ID = "builtin:coding-ideas-v2";
const CUSTOM_ID = "WF-CUSTOM";

function definition(id: string): WorkflowDefinition {
  const builtin = getBuiltinWorkflow(id);
  if (builtin) return builtin;
  return { ...getBuiltinWorkflow("builtin:coding")!, id, name: id };
}

function definitionStore() {
  return {
    getWorkflowDefinition: vi.fn(async (id: string) => definition(id)),
  } as unknown as TaskStore;
}

function selectionWriterStore() {
  const writeTaskWorkflowSelection = vi.fn(async () => undefined);
  const store = {
    asyncLayer: { db: {} },
    withTaskLock: async (_taskId: string, operation: () => Promise<string[]>) => operation(),
    getWorkflowDefinition: vi.fn(async (id: string) => definition(id)),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    resolveTaskCustomFieldDefsSync: vi.fn(() => []),
    updateTaskUnlocked: vi.fn(async () => undefined),
    writeTaskWorkflowSelection,
    reconcileTaskCustomFieldsForSchema: vi.fn(async () => undefined),
  } as unknown as TaskStore;
  return { store, writeTaskWorkflowSelection };
}

function workflowSwitchStore() {
  const selectTaskWorkflow = vi.fn(async () => []);
  const store = {
    asyncLayer: {},
    selectTaskWorkflow,
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getWorkflowDefinition: vi.fn(async (id: string) => definition(id)),
  } as unknown as TaskStore;
  return { store, selectTaskWorkflow };
}

function asyncLayerWithRows(rows: Array<{ taskId?: string; workflowId: string; stepIds: unknown }>): TaskStore {
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => rows),
          then: (resolve: (value: typeof rows) => unknown) => Promise.resolve(rows).then(resolve),
        })),
      })),
    })),
  };
  return { asyncLayer: { projectId: "project-successor", db } } as unknown as TaskStore;
}

describe("retired built-in workflow succession", () => {
  it("materializes the canonical successor identity (m1)", async () => {
    await expect(materializeExplicitWorkflowStepsImpl(definitionStore(), RETIRED_ID))
      .resolves.toMatchObject({ workflowId: SUCCESSOR_ID });
  });

  it("normalizes direct task selection before writing (m2)", async () => {
    const { store, writeTaskWorkflowSelection } = selectionWriterStore();

    await selectTaskWorkflowImpl(store, "FN-1", RETIRED_ID);

    expect(writeTaskWorkflowSelection).toHaveBeenCalledWith("FN-1", SUCCESSOR_ID, expect.any(Array));
  });

  it("accepts a retired switch request and reconciles through the successor (m3)", async () => {
    const { store, selectTaskWorkflow } = workflowSwitchStore();

    await expect(selectTaskWorkflowAndReconcileImpl(store, "FN-1", RETIRED_ID)).resolves.toBeDefined();
    expect(selectTaskWorkflow).toHaveBeenCalledWith("FN-1", SUCCESSOR_ID);
  });

  it.each([SUCCESSOR_ID, "builtin:coding", CUSTOM_ID])(
    "leaves supported identity %s unchanged across write paths (m4)",
    async (workflowId) => {
      const materialized = await materializeExplicitWorkflowStepsImpl(definitionStore(), workflowId);
      expect(materialized.workflowId).toBe(workflowId);

      const direct = selectionWriterStore();
      await selectTaskWorkflowImpl(direct.store, "FN-1", workflowId);
      expect(direct.writeTaskWorkflowSelection).toHaveBeenCalledWith("FN-1", workflowId, expect.any(Array));

      const reconciled = workflowSwitchStore();
      await selectTaskWorkflowAndReconcileImpl(reconciled.store, "FN-1", workflowId);
      expect(reconciled.selectTaskWorkflow).toHaveBeenCalledWith("FN-1", workflowId);
    },
  );

  it("normalizes a retired project default before persistence (m5)", async () => {
    const updateSettings = vi.fn(async () => undefined);
    const store = {
      getWorkflowDefinition: vi.fn(async (id: string) => definition(id)),
      updateSettings,
    } as unknown as TaskStore;

    await setDefaultWorkflowIdImpl(store, RETIRED_ID);

    expect(updateSettings).toHaveBeenCalledWith({ defaultWorkflowId: SUCCESSOR_ID });
  });

  it("canonicalizes the authoritative per-task selection and preserves steps (r1)", async () => {
    const stepIds = ["plan-review", "code-review"];
    const store = asyncLayerWithRows([{ workflowId: RETIRED_ID, stepIds }]);

    await expect(getTaskWorkflowSelectionAsyncImpl(store, "FN-1")).resolves.toEqual({
      workflowId: SUCCESSOR_ID,
      stepIds,
    });
  });

  it("canonicalizes batch selections into one successor identity (r2)", async () => {
    const store = asyncLayerWithRows([
      { taskId: "FN-old", workflowId: RETIRED_ID, stepIds: ["plan-review"] },
      { taskId: "FN-new", workflowId: SUCCESSOR_ID, stepIds: ["code-review"] },
    ]);

    const selections = await getTaskWorkflowSelectionsAsyncImpl(store, ["FN-old", "FN-new"]);

    expect(selections.get("FN-old")?.workflowId).toBe(SUCCESSOR_ID);
    expect(selections.get("FN-new")?.workflowId).toBe(SUCCESSOR_ID);
    expect(new Set([...selections.values()].map((selection) => selection.workflowId)).size).toBe(1);
  });

  it.each(["builtin:coding", SUCCESSOR_ID, CUSTOM_ID])(
    "leaves supported identity %s unchanged in authoritative reads (r3)",
    async (workflowId) => {
      const single = asyncLayerWithRows([{ workflowId, stepIds: [] }]);
      expect((await getTaskWorkflowSelectionAsyncImpl(single, "FN-1"))?.workflowId).toBe(workflowId);

      const batch = asyncLayerWithRows([{ taskId: "FN-1", workflowId, stepIds: [] }]);
      expect((await getTaskWorkflowSelectionsAsyncImpl(batch, ["FN-1"])).get("FN-1")?.workflowId).toBe(workflowId);
    },
  );

  it("uses the successor configuration key for a retired definition request", async () => {
    const applyBuiltInPromptOverridesAsync = vi.fn(async (_id: string, ir: unknown) => ir);
    const store = {
      applyBuiltInPromptOverridesAsync,
      isPluginInstalled: vi.fn(async () => true),
    } as unknown as TaskStore;

    const resolved = await getWorkflowDefinitionImpl(store, RETIRED_ID);

    expect(resolved?.id).toBe(SUCCESSOR_ID);
    expect(applyBuiltInPromptOverridesAsync).toHaveBeenCalledWith(SUCCESSOR_ID, expect.any(Object));
  });

  it.each([
    { holderWorkflowId: RETIRED_ID, candidateWorkflowId: SUCCESSOR_ID },
    { holderWorkflowId: SUCCESSOR_ID, candidateWorkflowId: RETIRED_ID },
  ])(
    "shares sync and async capacity pools for $holderWorkflowId holder and $candidateWorkflowId candidate",
    async ({ holderWorkflowId, candidateWorkflowId }) => {
      const rows = [{
        id: "FN-holder",
        col: "in-progress",
        tp: null,
        wid: holderWorkflowId,
      }];
      const params = {
        targetColumn: "in-progress",
        workflowId: candidateWorkflowId,
        countPending: true,
        excludeTaskId: "FN-candidate",
      };
      const syncStore = {
        db: {
          prepare: vi.fn(() => ({ all: vi.fn(() => rows) })),
        },
      } as unknown as TaskStore;
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            leftJoin: vi.fn(() => ({
              where: vi.fn(async () => rows),
            })),
          })),
        })),
      };

      expect(resolveCapacityPoolId(holderWorkflowId)).toBe(SUCCESSOR_ID);
      expect(resolveCapacityPoolId(candidateWorkflowId)).toBe(SUCCESSOR_ID);
      expect(countActiveInCapacitySlotSyncImpl(syncStore, params)).toBe(1);
      await expect(countActiveInCapacitySlotAsyncImpl({} as TaskStore, {
        ...params,
        tx: tx as never,
      })).resolves.toBe(1);
    },
  );
});
