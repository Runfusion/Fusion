import { describe, it, expect, vi } from "vitest";

import { resolveExecutionSettingsModel, type Settings } from "@fusion/core";
import { mergeEffectiveSettings } from "../project/effective-settings.js";

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
 * Model-lane chain after workflow overlay: selected workflow → project → global → default.
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

  it("a non-default selected workflow wins over project and global lanes", async () => {
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
      executionProvider: "project-prov",
      executionModelId: "project-model",
      executionGlobalProvider: "global-prov",
      executionGlobalModelId: "global-model",
    } as unknown as Settings);

    expect(resolveExecutionSettingsModel(merged)).toEqual({ provider: "workflow-prov", modelId: "workflow-model" });
    expect(merged.selectedWorkflowModelLanes).toMatchObject({ executionProvider: "workflow-prov", executionModelId: "workflow-model" });
  });

  it("reads project lanes directly when no selected workflow overlay is present", () => {
    const settings = {
      executionProvider: "project-prov",
      executionModelId: "project-model",
      executionGlobalProvider: "global-prov",
      executionGlobalModelId: "global-model",
    } as unknown as Settings;

    expect(resolveExecutionSettingsModel(settings)).toEqual({ provider: "project-prov", modelId: "project-model" });
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
