import { describe, it, expect, vi } from "vitest";

import { resolveExecutionSettingsModel, type Settings } from "@fusion/core";
import { mergeEffectiveSettings, mergeProjectWorkflowModelLaneBaseline } from "../project/effective-settings.js";

const PROJECT = "proj-1";

function makeStore(values?: Record<string, unknown>) {
  return {
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: [] })),
    getWorkflowDefinition: vi.fn(async () => undefined),
    getWorkflowSettingValues: vi.fn(() => values ?? {}),
    getWorkflowSettingsProjectId: vi.fn(() => PROJECT),
  };
}

/**
 * KTD-7 model-lane chain, pinned AFTER the entry merge. The chain reads
 * `settings.executionProvider` (Project Models baseline) → global lane →
 * selected-workflow value → project/global default.
 */
describe("model-lane resolution after effective-settings merge (KTD-7)", () => {
  it("project workflow baseline set → wins over global lane and defaults", async () => {
    const base = {
      executionGlobalProvider: "global-prov",
      executionGlobalModelId: "global-model",
      defaultProvider: "def-prov",
      defaultModelId: "def-model",
    } as unknown as Settings;
    const merged = await mergeEffectiveSettings(
      makeStore({ executionProvider: "wf-prov", executionModelId: "wf-model" }) as any,
      { id: "t1" },
      base,
    );
    expect(resolveExecutionSettingsModel(merged)).toEqual({ provider: "wf-prov", modelId: "wf-model" });
  });

  it("global lane wins over a non-default selected workflow value when the project baseline is empty", async () => {
    const store = {
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "wf-custom", stepIds: [] })),
      getDefaultWorkflowId: vi.fn(async () => "builtin:coding"),
      getWorkflowDefinition: vi.fn(async (id: string) => id === "wf-custom"
        ? {
            ir: {
              version: "v2",
              name: "Custom",
              columns: [],
              nodes: [],
              edges: [],
              settings: [
                { id: "executionProvider", name: "Execution provider", type: "string" },
                { id: "executionModelId", name: "Execution model", type: "string" },
              ],
            },
          }
        : undefined),
      getWorkflowSettingValues: vi.fn((workflowId: string) => workflowId === "wf-custom"
        ? { executionProvider: "workflow-prov", executionModelId: "workflow-model" }
        : {}),
      getWorkflowSettingsProjectId: vi.fn(() => PROJECT),
    };
    const merged = await mergeEffectiveSettings(store as any, { id: "t1" }, {
      executionGlobalProvider: "global-prov",
      executionGlobalModelId: "global-model",
    } as unknown as Settings);

    expect(resolveExecutionSettingsModel(merged)).toEqual({ provider: "global-prov", modelId: "global-model" });
    expect(merged.selectedWorkflowModelLanes).toMatchObject({ executionProvider: "workflow-prov", executionModelId: "workflow-model" });
  });

  it("loads the project workflow baseline for model sessions without a task", async () => {
    const store = {
      getDefaultWorkflowId: vi.fn(async () => "builtin:coding"),
      getWorkflowDefinition: vi.fn(async () => undefined),
      getWorkflowSettingValues: vi.fn(() => ({ executionProvider: "project-prov", executionModelId: "project-model" })),
      getWorkflowSettingsProjectId: vi.fn(() => PROJECT),
    };
    const merged = await mergeProjectWorkflowModelLaneBaseline(store as any, {
      executionGlobalProvider: "global-prov",
      executionGlobalModelId: "global-model",
    } as unknown as Settings);

    expect(resolveExecutionSettingsModel(merged)).toEqual({ provider: "project-prov", modelId: "project-model" });
  });

  it("workflow lane empty → falls through to the global lane", async () => {
    const base = {
      executionGlobalProvider: "global-prov",
      executionGlobalModelId: "global-model",
      defaultProvider: "def-prov",
      defaultModelId: "def-model",
    } as unknown as Settings;
    // No stored workflow lane; builtin declarations omit lane defaults → lane absent.
    const merged = await mergeEffectiveSettings(makeStore() as any, { id: "t1" }, base);
    expect(resolveExecutionSettingsModel(merged)).toEqual({ provider: "global-prov", modelId: "global-model" });
  });

  it("workflow + global lanes empty → falls through to the global default", async () => {
    const base = {
      defaultProvider: "def-prov",
      defaultModelId: "def-model",
    } as unknown as Settings;
    const merged = await mergeEffectiveSettings(makeStore() as any, { id: "t1" }, base);
    expect(resolveExecutionSettingsModel(merged)).toEqual({ provider: "def-prov", modelId: "def-model" });
  });
});
